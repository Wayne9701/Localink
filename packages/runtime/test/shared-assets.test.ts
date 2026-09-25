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

function fixtureServer(calls: Map<string, number>): McpServer {
  const server = new McpServer({ name: 'm4-http-fixture', version: '1.0.0' });
  const register = (
    name: string,
    annotations:
      | {
          readOnlyHint: boolean;
          destructiveHint: boolean;
          openWorldHint?: boolean;
        }
      | undefined,
  ) =>
    server.registerTool(
      name,
      {
        title: `HTTP ${name}`,
        description: `HTTP fixture ${name}`,
        inputSchema: z.strictObject({ value: z.string().optional() }),
        ...(annotations === undefined ? {} : { annotations }),
      },
      (input) => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return {
          content: [{ type: 'text', text: JSON.stringify({ name, input }) }],
          structuredContent: { name, input },
        };
      },
    );
  register('fixture_read', { readOnlyHint: true, destructiveHint: false });
  register('fixture_write', { readOnlyHint: false, destructiveHint: false });
  register('fixture_destroy', { readOnlyHint: true, destructiveHint: true });
  register('fixture_open_world', {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });
  register('fixture_unknown', undefined);
  return server;
}

async function startHttpFixture() {
  const calls = new Map<string, number>();
  const handler = createMcpHandler(() => fixtureServer(calls), {
    legacy: 'reject',
  });
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
    calls,
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
  assert.deepEqual(
    parseExternalMcpProvider({
      id: 'local',
      transport: 'loopback-http',
      url: 'http://127.0.0.1:33332/mcp',
      enabled: true,
    }),
    {
      id: 'local',
      transport: 'loopback-http',
      url: 'http://127.0.0.1:33332/mcp',
      enabled: true,
    },
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
    {
      id: 'tier3-forbidden',
      transport: 'loopback-http',
      url: 'http://127.0.0.1:33332/mcp',
      enabled: true,
      toolRiskOverrides: { fixture_unknown: 3 },
    },
    {
      id: 'pattern-forbidden',
      transport: 'loopback-http',
      url: 'http://127.0.0.1:33332/mcp',
      enabled: true,
      toolRiskOverrides: { 'fixture_*': 0 },
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

test('loopback HTTP projects annotation-derived tiers and keeps health private', async (t) => {
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
      4,
      JSON.stringify(await runtime.health()),
    );
    const descriptor = capabilities.find((item) =>
      item.title.includes('fixture_read'),
    );
    const writeDescriptor = capabilities.find((item) =>
      item.title.includes('fixture_write'),
    );
    const destroyDescriptor = capabilities.find((item) =>
      item.title.includes('fixture_destroy'),
    );
    const openWorldDescriptor = capabilities.find((item) =>
      item.title.includes('fixture_open_world'),
    );
    assert.ok(descriptor && writeDescriptor && destroyDescriptor);
    assert.ok(openWorldDescriptor);
    assert.equal(descriptor.operationClass, 'read');
    assert.equal(descriptor.riskTier, 0);
    assert.equal(descriptor.postVerify, 'none');
    assert.deepEqual(descriptor.requiredScopes, []);
    assert.equal(writeDescriptor.operationClass, 'write');
    assert.equal(writeDescriptor.riskTier, 1);
    assert.equal(destroyDescriptor.riskTier, 2);
    assert.equal(openWorldDescriptor.riskTier, 2);
    assert.equal(runtime.capabilities.search('fixture_unknown').length, 0);
    const receipt = await runtime.capabilities.invoke(
      descriptor.id,
      { value: 'http-ok' },
      { policyProfile: 'balanced' },
    );
    assert.equal(receipt.status, 'executed');
    assert.equal(JSON.stringify(receipt.output).includes('fixture_read'), true);
    const writeReceipt = await runtime.capabilities.invoke(
      writeDescriptor.id,
      { value: 'write-ok' },
      { policyProfile: 'balanced' },
    );
    assert.equal(writeReceipt.status, 'executed');
    assert.equal(fixture.calls.get('fixture_write'), 1);
    const destroyReceipt = await runtime.capabilities.invoke(
      destroyDescriptor.id,
      { value: 'confirmed-once' },
      { policyProfile: 'balanced' },
    );
    assert.equal(destroyReceipt.status, 'confirmation_required');
    assert.equal(fixture.calls.get('fixture_destroy') ?? 0, 0);
    assert.ok(destroyReceipt.confirmation);
    const confirmed = await runtime.capabilities.invokeConfirmed(
      destroyReceipt.confirmation.ticket,
      destroyDescriptor.id,
      { value: 'confirmed-once' },
      { policyProfile: 'balanced' },
    );
    assert.equal(confirmed.status, 'executed');
    assert.equal(fixture.calls.get('fixture_destroy'), 1);
    await assert.rejects(
      runtime.capabilities.invokeConfirmed(
        destroyReceipt.confirmation.ticket,
        destroyDescriptor.id,
        { value: 'confirmed-once' },
        { policyProfile: 'balanced' },
      ),
      (error) =>
        error instanceof LocalinkError && error.code === 'INVALID_ARGUMENT',
    );
    const health = await runtime.health();
    assert.equal(health.sharedAssets.externalMcp.providerCount, 2);
    assert.equal(health.sharedAssets.externalMcp.readyProviders, 1);
    assert.equal(health.sharedAssets.externalMcp.degradedProviders, 1);
    assert.equal(health.sharedAssets.externalMcp.registeredReadCapabilities, 1);
    assert.equal(health.sharedAssets.externalMcp.registeredCapabilities, 4);
    assert.deepEqual(
      health.sharedAssets.externalMcp.registeredCapabilitiesByTier,
      { 0: 1, 1: 1, 2: 2 },
    );
    assert.equal(
      health.sharedAssets.externalMcp.providers[0]?.eligibleProjectedTools,
      4,
    );
    assert.equal(health.sharedAssets.externalMcp.providers[0]?.skippedTools, 1);
    assert.equal(JSON.stringify(health).includes(fixture.url), false);
    await runtime.close();
  });
});

test('exact local overrides project unannotated tools and can lower audited destructive annotations', async (t) => {
  const fixture = await startHttpFixture();
  t.after(() => fixture.close());
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const setup = await createLocalinkRuntime({ stateRoot });
    await setup.addHttpProvider('overridden', fixture.url);
    await setup.setExternalMcpToolRiskOverride(
      'overridden',
      'fixture_unknown',
      0,
    );
    await setup.setExternalMcpToolRiskOverride(
      'overridden',
      'fixture_destroy',
      0,
    );
    assert.deepEqual(await setup.externalMcpToolRiskOverrides('overridden'), {
      fixture_unknown: 0,
      fixture_destroy: 0,
    });
    await setup.close();

    const runtime = await createLocalinkRuntime({ stateRoot });
    const unknown = runtime.capabilities
      .list()
      .find((item) => item.title.includes('fixture_unknown'));
    const destructive = runtime.capabilities
      .list()
      .find((item) => item.title.includes('fixture_destroy'));
    assert.ok(unknown && destructive);
    assert.equal(unknown.riskTier, 0);
    assert.equal(destructive.riskTier, 0);
    assert.ok(unknown.description.includes('local exact-name override'));
    assert.equal(
      (
        await runtime.capabilities.invoke(
          destructive.id,
          {},
          { policyProfile: 'balanced' },
        )
      ).status,
      'executed',
    );
    const health = await runtime.health();
    assert.deepEqual(
      health.sharedAssets.externalMcp.registeredCapabilitiesByTier,
      { 0: 3, 1: 1, 2: 1 },
    );
    await runtime.removeExternalMcpToolRiskOverride(
      'overridden',
      'fixture_unknown',
    );
    assert.deepEqual(await runtime.externalMcpToolRiskOverrides('overridden'), {
      fixture_destroy: 0,
    });
    await runtime.close();
  });
});

test('unknown exact override is isolated and cannot match or open a tool', async (t) => {
  const fixture = await startHttpFixture();
  t.after(() => fixture.close());
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const setup = await createLocalinkRuntime({ stateRoot });
    await setup.addHttpProvider('unknown-override', fixture.url);
    await setup.setExternalMcpToolRiskOverride(
      'unknown-override',
      'fixture_not_present',
      0,
    );
    await setup.close();
    const runtime = await createLocalinkRuntime({ stateRoot });
    assert.equal(runtime.capabilities.list().length, 4);
    assert.equal(runtime.capabilities.search('fixture_not_present').length, 0);
    const status = (await runtime.health()).sharedAssets.externalMcp
      .providers[0];
    assert.equal(status?.state, 'degraded');
    assert.equal(status?.reasonCode, 'PROVIDER_TOOL_OVERRIDE_UNKNOWN');
    await runtime.close();
  });
});

test('stdio bridge projects annotated tools, isolates environment, and reaps child on close', async () => {
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
    assert.equal(capabilities.length, 3);
    const descriptor = capabilities.find((item) =>
      item.title.includes('fixture_read'),
    );
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
    assert.equal(health.sharedAssets.externalMcp.providers[0]?.skippedTools, 1);
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
      const capability = running.capabilities
        .list()
        .find((item) => item.title.includes('fixture_read'));
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
      assert.equal(running.capabilities.list().length, 3);
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
