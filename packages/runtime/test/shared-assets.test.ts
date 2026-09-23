import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
} from '@modelcontextprotocol/node';
import { z } from 'zod';
import { LocalinkError } from '@localink/sdk';
import {
  EXTERNAL_MCP_LIMITS,
  SKILL_SOURCE_LIMITS,
  createLocalinkRuntime,
  parseExternalMcpProvider,
  validateExternalMcpConfig,
} from '../src/index.js';

const stdioFixture = fileURLToPath(
  new URL('./external-mcp-stdio-fixture.js', import.meta.url),
);

async function withTemp(
  worker: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-m4-test-'));
  try {
    await worker(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fixtureServer(): McpServer {
  const server = new McpServer({ name: 'm4-http-fixture', version: '1.0.0' });
  const register = (
    name: string,
    annotations:
      { readOnlyHint: boolean; destructiveHint: boolean } | undefined,
  ) =>
    server.registerTool(
      name,
      {
        title: `HTTP ${name}`,
        description: `HTTP fixture ${name}`,
        inputSchema: z.strictObject({ value: z.string().optional() }),
        ...(annotations === undefined ? {} : { annotations }),
      },
      (input) => ({
        content: [{ type: 'text', text: JSON.stringify({ name, input }) }],
        structuredContent: { name, input },
      }),
    );
  register('fixture_read', { readOnlyHint: true, destructiveHint: false });
  register('fixture_write', { readOnlyHint: false, destructiveHint: false });
  register('fixture_destroy', { readOnlyHint: true, destructiveHint: true });
  register('fixture_unknown', undefined);
  return server;
}

async function startHttpFixture() {
  const handler = createMcpHandler(() => fixtureServer(), { legacy: 'reject' });
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response))
      return;
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'https://example.com/mcp' }).end();
      return;
    }
    void nodeHandler(request as NodeIncomingMessageLike, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await handler.close();
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

test('configured Skill sources persist, load real SKILL.md safely, and isolate bad items/sources', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const sourceRoot = path.join(root, 'skills');
    const outside = path.join(root, 'outside');
    await mkdir(path.join(sourceRoot, 'example', 'scripts'), {
      recursive: true,
    });
    await mkdir(path.join(sourceRoot, 'example', 'assets'));
    await mkdir(path.join(sourceRoot, 'broken'));
    await mkdir(path.join(sourceRoot, 'oversized'));
    await mkdir(path.join(sourceRoot, 'linked-skill'));
    await mkdir(path.join(sourceRoot, 'a+b'));
    await mkdir(path.join(sourceRoot, 'a-b'));
    await mkdir(outside);
    const skillContent = `---\nname: Example Shared Skill\ndescription: Reads shared metadata safely.\n---\n# Example\n${'bounded '.repeat(80)}`;
    await writeFile(path.join(sourceRoot, 'example', 'SKILL.md'), skillContent);
    await writeFile(
      path.join(sourceRoot, 'example', 'scripts', 'never-run.sh'),
      'exit 99\n',
    );
    await writeFile(
      path.join(sourceRoot, 'example', 'assets', 'private.txt'),
      'ASSET_MUST_NOT_LOAD',
    );
    await chmod(
      path.join(sourceRoot, 'example', 'assets', 'private.txt'),
      0o000,
    );
    await writeFile(
      path.join(sourceRoot, 'broken', 'SKILL.md'),
      '---\nname: no-close',
    );
    await writeFile(
      path.join(sourceRoot, 'oversized', 'SKILL.md'),
      Buffer.alloc(SKILL_SOURCE_LIMITS.skillBytes + 1, 97),
    );
    await writeFile(path.join(outside, 'SKILL.md'), '# escaped');
    await writeFile(path.join(sourceRoot, 'a+b', 'SKILL.md'), '# First');
    await writeFile(path.join(sourceRoot, 'a-b', 'SKILL.md'), '# Second');
    await symlink(
      path.join(outside, 'SKILL.md'),
      path.join(sourceRoot, 'linked-skill', 'SKILL.md'),
    );
    await symlink(outside, path.join(sourceRoot, 'directory-link'));

    const first = await createLocalinkRuntime({ stateRoot });
    assert.deepEqual(await first.skillSources(), []);
    assert.deepEqual(await first.addSkillSource('shared', sourceRoot), {
      id: 'shared',
      root: sourceRoot,
      enabled: true,
    });
    await first.addSkillSource('missing', path.join(root, 'missing-source'));
    await first.close();

    const restarted = await createLocalinkRuntime({ stateRoot });
    const found = restarted.skills.search('Example Shared');
    assert.equal(found.length, 1);
    assert.equal(found[0]?.manifest.id, 'skill.shared.example');
    assert.equal(found[0]?.location, 'source:shared/example/SKILL.md');
    assert.equal(
      restarted.skills
        .list()
        .filter((item) => item.manifest.id === 'skill.shared.a-b').length,
      1,
    );
    assert.equal(JSON.stringify(found).includes(root), false);
    const read = restarted.skills.read('skill.shared.example', 64);
    assert.equal(read.truncated, true);
    assert.equal(read.content.includes('ASSET_MUST_NOT_LOAD'), false);
    const health = await restarted.health();
    assert.deepEqual(health.sharedAssets.skillSources, {
      configured: 2,
      loadedSkills: 2,
      degraded: 2,
    });
    assert.equal(JSON.stringify(health).includes(root), false);
    assert.deepEqual(await restarted.removeSkillSource('shared'), {
      id: 'shared',
      root: sourceRoot,
      enabled: true,
    });
    await restarted.removeSkillSource('missing');
    await restarted.close();

    const empty = await createLocalinkRuntime({ stateRoot });
    assert.deepEqual(empty.skills.list(), []);
    await empty.close();
  });
});

test('running runtime atomically refreshes external skill source add/remove', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const sourceRoot = path.join(root, 'skills');
    await mkdir(path.join(sourceRoot, 'example'), { recursive: true });
    await writeFile(
      path.join(sourceRoot, 'example', 'SKILL.md'),
      '# Dynamic Shared Skill\nSynthetic read only.\n',
    );
    const running = await createLocalinkRuntime({ stateRoot });
    const cli = await createLocalinkRuntime({ stateRoot });
    try {
      assert.deepEqual(running.skills.list(), []);
      await cli.addSkillSource('shared', sourceRoot);
      await running.refreshSkillSources();
      assert.equal(running.skills.search('Dynamic Shared Skill').length, 1);
      assert.equal(
        running.skills.read('skill.shared.example', 128).location,
        'source:shared/example/SKILL.md',
      );
      assert.equal(
        (await running.health()).sharedAssets.skillSources.loadedSkills,
        1,
      );
      const previous = running.skills;
      await writeFile(
        path.join(stateRoot, 'config', 'skill-sources.json'),
        '{bad json',
      );
      await assert.rejects(
        running.refreshSkillSources(),
        (error) =>
          error instanceof LocalinkError && error.code === 'CONFIG_INVALID',
      );
      assert.equal(running.skills, previous);
      assert.equal(running.skills.list().length, 1);
      await writeFile(
        path.join(stateRoot, 'config', 'skill-sources.json'),
        JSON.stringify({
          version: 1,
          sources: [{ id: 'shared', root: sourceRoot, enabled: true }],
        }),
      );
      await cli.removeSkillSource('shared');
      await running.refreshSkillSources();
      assert.deepEqual(running.skills.list(), []);
      assert.equal(
        (await running.health()).sharedAssets.skillSources.configured,
        0,
      );
    } finally {
      await Promise.all([running.close(), cli.close()]);
    }
  });
});

test('provider config accepts only bounded credential-free loopback HTTP or absolute stdio', () => {
  assert.equal(
    parseExternalMcpProvider({
      id: 'local',
      transport: 'loopback-http',
      url: 'http://127.0.0.1:33332/mcp',
      enabled: true,
    }).transport,
    'loopback-http',
  );
  for (const value of [
    {
      id: 'remote',
      transport: 'loopback-http',
      url: 'https://example.com/mcp',
      enabled: true,
    },
    {
      id: 'userinfo',
      transport: 'loopback-http',
      url: 'http://user:pass@localhost/mcp',
      enabled: true,
    },
    {
      id: 'relative',
      transport: 'stdio',
      command: 'node',
      args: [],
      enabled: true,
    },
    {
      id: 'secret-field',
      transport: 'stdio',
      command: process.execPath,
      args: [],
      env: { API_KEY: 'not-allowed' },
      enabled: true,
    },
    {
      id: 'secret-arg',
      transport: 'stdio',
      command: process.execPath,
      args: ['--token=not-allowed'],
      enabled: true,
    },
    {
      id: 'too-many',
      transport: 'stdio',
      command: process.execPath,
      args: Array(EXTERNAL_MCP_LIMITS.args + 1).fill('x'),
      enabled: true,
    },
  ]) {
    assert.throws(
      () => parseExternalMcpProvider(value),
      (error) =>
        error instanceof LocalinkError && error.code === 'CONFIG_INVALID',
    );
  }
  assert.throws(
    () =>
      validateExternalMcpConfig({
        version: 1,
        providers: Array(EXTERNAL_MCP_LIMITS.providers + 1).fill(null),
      }),
    (error) =>
      error instanceof LocalinkError && error.code === 'CONFIG_INVALID',
  );
});

test('loopback HTTP projects only annotated non-destructive reads and keeps health private', async (t) => {
  const fixture = await startHttpFixture();
  t.after(() => fixture.close());
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const setup = await createLocalinkRuntime({ stateRoot });
    await setup.addHttpProvider('fixture-http', fixture.url);
    await setup.addHttpProvider(
      'redirect-http',
      fixture.url.replace('/mcp', '/redirect'),
    );
    await setup.close();

    const runtime = await createLocalinkRuntime({ stateRoot });
    const capabilities = runtime.capabilities.search('fixture');
    assert.equal(
      capabilities.length,
      1,
      JSON.stringify(await runtime.health()),
    );
    const descriptor = capabilities[0];
    assert.ok(descriptor);
    assert.equal(descriptor.operationClass, 'read');
    assert.equal(descriptor.riskTier, 0);
    assert.equal(descriptor.postVerify, 'none');
    assert.deepEqual(descriptor.requiredScopes, []);
    assert.ok(descriptor.title.includes('fixture_read'));
    const receipt = await runtime.capabilities.invoke(
      descriptor.id,
      { value: 'http-ok' },
      { policyProfile: 'balanced' },
    );
    assert.equal(receipt.status, 'executed');
    assert.equal(JSON.stringify(receipt.output).includes('fixture_read'), true);
    const health = await runtime.health();
    assert.equal(health.sharedAssets.externalMcp.providerCount, 2);
    assert.equal(health.sharedAssets.externalMcp.readyProviders, 1);
    assert.equal(health.sharedAssets.externalMcp.degradedProviders, 1);
    assert.equal(health.sharedAssets.externalMcp.registeredReadCapabilities, 1);
    assert.equal(health.sharedAssets.externalMcp.providers[0]?.skippedTools, 3);
    assert.equal(JSON.stringify(health).includes(fixture.url), false);
    await runtime.close();
  });
});

test('stdio bridge projects read-only tools, isolates environment, and reaps child on close', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const pidFile = path.join(root, 'provider.pid');
    const setup = await createLocalinkRuntime({ stateRoot });
    await setup.addStdioProvider('fixture-stdio', process.execPath, [
      stdioFixture,
      pidFile,
    ]);
    await setup.close();

    const runtime = await createLocalinkRuntime({
      stateRoot,
      environment: {
        ...process.env,
        LOCALINK_STATE_ROOT: stateRoot,
        LOCALINK_TEST_SECRET: 'MUST_NOT_REACH_CHILD',
      },
    });
    const capabilities = runtime.capabilities.search('fixture');
    assert.equal(capabilities.length, 1);
    const descriptor = capabilities[0];
    assert.ok(descriptor);
    const receipt = await runtime.capabilities.invoke(
      descriptor.id,
      { value: 'stdio-ok' },
      { policyProfile: 'balanced' },
    );
    assert.equal(receipt.status, 'executed');
    assert.equal(
      JSON.stringify(receipt.output).includes('LOCALINK_TEST_SECRET'),
      false,
    );
    assert.equal(
      JSON.stringify(receipt.output).includes('MUST_NOT_REACH_CHILD'),
      false,
    );
    const health = await runtime.health();
    assert.equal(health.sharedAssets.externalMcp.readyProviders, 1);
    assert.equal(health.sharedAssets.externalMcp.providers[0]?.skippedTools, 3);
    assert.equal(JSON.stringify(health).includes(process.execPath), false);
    assert.equal(JSON.stringify(health).includes(stdioFixture), false);
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    await runtime.close();
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        return;
      }
    }
    assert.fail('stdio provider child remained alive after runtime close');
  });
});

test('running runtime refreshes external provider capabilities and closes removed connection', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const pidFile = path.join(root, 'dynamic-provider.pid');
    const running = await createLocalinkRuntime({ stateRoot });
    const cli = await createLocalinkRuntime({ stateRoot });
    try {
      assert.deepEqual(running.capabilities.list(), []);
      await cli.addStdioProvider('dynamic', process.execPath, [
        stdioFixture,
        pidFile,
      ]);
      await running.refreshExternalMcp();
      const capability = running.capabilities.search('fixture_read')[0];
      assert.ok(capability);
      assert.equal(
        (
          await running.capabilities.invoke(
            capability.id,
            { value: 'dynamic-ok' },
            { policyProfile: 'balanced' },
          )
        ).status,
        'executed',
      );
      assert.equal(
        (await running.health()).sharedAssets.externalMcp
          .registeredReadCapabilities,
        1,
      );
      const previous = running.capabilities;
      await writeFile(
        path.join(stateRoot, 'config', 'external-mcp.json'),
        '{bad json',
      );
      await assert.rejects(
        running.refreshExternalMcp(),
        (error) =>
          error instanceof LocalinkError && error.code === 'CONFIG_INVALID',
      );
      assert.equal(running.capabilities, previous);
      assert.equal(running.capabilities.list().length, 1);
      await writeFile(
        path.join(stateRoot, 'config', 'external-mcp.json'),
        JSON.stringify({
          version: 1,
          providers: [
            {
              id: 'dynamic',
              transport: 'stdio',
              command: process.execPath,
              args: [stdioFixture, pidFile],
              enabled: true,
            },
          ],
        }),
      );
      const pid = Number(await readFile(pidFile, 'utf8'));
      await cli.removeExternalMcpProvider('dynamic');
      await running.refreshExternalMcp();
      assert.deepEqual(running.capabilities.list(), []);
      assert.equal(
        (await running.health()).sharedAssets.externalMcp.providerCount,
        0,
      );
      let exited = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          exited = true;
          break;
        }
      }
      assert.equal(exited, true);
      await cli.addHttpProvider('offline', 'http://127.0.0.1:1/mcp');
      await running.refreshExternalMcp();
      const health = await running.health();
      assert.equal(health.state.ready, true);
      assert.equal(health.sharedAssets.externalMcp.degradedProviders, 1);
      assert.deepEqual(running.capabilities.list(), []);
    } finally {
      await Promise.all([running.close(), cli.close()]);
    }
  });
});

test('unavailable provider degrades only its bridge while Core stays ready', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const setup = await createLocalinkRuntime({ stateRoot });
    await setup.addHttpProvider('offline', 'http://127.0.0.1:1/mcp');
    await setup.close();
    const runtime = await createLocalinkRuntime({ stateRoot });
    const health = await runtime.health();
    assert.equal(health.state.ready, true);
    assert.equal(health.sharedAssets.externalMcp.readyProviders, 0);
    assert.equal(health.sharedAssets.externalMcp.degradedProviders, 1);
    assert.equal(
      health.sharedAssets.externalMcp.providers[0]?.reasonCode,
      'PROVIDER_UNAVAILABLE',
    );
    assert.deepEqual(runtime.capabilities.list(), []);
    await runtime.close();
  });
});
