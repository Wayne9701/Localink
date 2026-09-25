import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalinkRuntime } from '@localink/runtime';
import { PROTOCOL_VERSION } from '@localink/mcp-server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const cliEntry = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function runCli(
  stateRoot: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [cliEntry, ...args], {
    env: { ...process.env, LOCALINK_STATE_ROOT: stateRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  return JSON.parse(stdout) as Record<string, unknown>;
}

test('CLI persists workspace identity across separate add/list/inspect/remove processes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-cli-test-'));
  try {
    const stateRoot = path.join(root, 'state');
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot);

    const initialHealth = await runCli(stateRoot, [
      'runtime',
      'health',
      '--json',
    ]);
    assert.equal(initialHealth.mode, 'runtime');
    assert.equal(initialHealth.workspaceCount, 0);

    const added = await runCli(stateRoot, [
      'workspace',
      'add',
      'primary',
      workspaceRoot,
      '--json',
    ]);
    assert.equal(added.name, 'primary');
    assert.equal(added.root, await realpath(workspaceRoot));
    assert.equal(typeof added.id, 'string');

    const listed = await runCli(stateRoot, ['workspace', 'list', '--json']);
    assert.deepEqual(listed.workspaces, [added]);

    const inspected = await runCli(stateRoot, [
      'workspace',
      'inspect',
      String(added.id),
      '--json',
    ]);
    assert.deepEqual(inspected, added);

    const removed = await runCli(stateRoot, [
      'workspace',
      'remove',
      String(added.id),
      '--json',
    ]);
    assert.deepEqual(removed, added);

    const empty = await runCli(stateRoot, ['workspace', 'list', '--json']);
    assert.deepEqual(empty.workspaces, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI process policy is disabled by default and persists explicit enable/disable with warning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-cli-policy-'));
  try {
    const stateRoot = path.join(root, 'state');
    assert.deepEqual(await runCli(stateRoot, ['process', 'policy', '--json']), {
      policy: { version: 1, enabled: false },
    });
    const enabled = await runCli(stateRoot, ['process', 'enable', '--json']);
    assert.deepEqual(enabled.policy, { version: 1, enabled: true });
    assert.equal(
      (enabled.warning as Record<string, unknown>).hostProcessExecution,
      true,
    );
    assert.equal(
      (enabled.warning as Record<string, unknown>).workspaceCwdIsOsSandbox,
      false,
    );
    assert.deepEqual(await runCli(stateRoot, ['process', 'policy', '--json']), {
      policy: { version: 1, enabled: true },
    });
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot);
    const added = await runCli(stateRoot, [
      'workspace',
      'add',
      'process-test',
      workspaceRoot,
      '--json',
    ]);
    const runtime = await createLocalinkRuntime({ stateRoot });
    const receipt = await runtime.native.processExec({
      workspaceId: String(added.id),
      command: process.execPath,
      args: ['-e', "process.stdout.write('cli-enabled')"],
      timeoutMs: 10_000,
    });
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.stdout.text, 'cli-enabled');
    await runtime.close();
    assert.deepEqual(
      await runCli(stateRoot, ['process', 'disable', '--json']),
      {
        policy: { version: 1, enabled: false },
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI persists local-only Skill source and external MCP provider configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-cli-assets-'));
  try {
    const stateRoot = path.join(root, 'state');
    const skillsRoot = path.join(root, 'skills');
    await mkdir(skillsRoot);
    assert.deepEqual(
      await runCli(stateRoot, ['skill-source', 'list', '--json']),
      {
        sources: [],
      },
    );
    const source = await runCli(stateRoot, [
      'skill-source',
      'add',
      'shared',
      skillsRoot,
      '--json',
    ]);
    assert.deepEqual(source, {
      id: 'shared',
      root: skillsRoot,
      enabled: true,
    });
    assert.deepEqual(
      await runCli(stateRoot, ['skill-source', 'list', '--json']),
      { sources: [source] },
    );

    const provider = await runCli(stateRoot, [
      'mcp-provider',
      'add-stdio',
      'fixture',
      process.execPath,
      '-e',
      'process.exit(0)',
      '--json',
    ]);
    assert.deepEqual(provider, {
      id: 'fixture',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      enabled: true,
    });
    assert.deepEqual(
      await runCli(stateRoot, ['mcp-provider', 'list', '--json']),
      { providers: [provider] },
    );
    const overridden = await runCli(stateRoot, [
      'mcp-provider',
      'risk',
      'set',
      'fixture',
      'fixture_unknown',
      '0',
      '--json',
    ]);
    assert.deepEqual(overridden, {
      ...provider,
      toolRiskOverrides: { fixture_unknown: 0 },
    });
    assert.deepEqual(
      await runCli(stateRoot, [
        'mcp-provider',
        'risk',
        'list',
        'fixture',
        '--json',
      ]),
      { providerId: 'fixture', overrides: { fixture_unknown: 0 } },
    );
    assert.deepEqual(
      await runCli(stateRoot, [
        'mcp-provider',
        'risk',
        'remove',
        'fixture',
        'fixture_unknown',
        '--json',
      ]),
      provider,
    );
    assert.deepEqual(
      await runCli(stateRoot, ['mcp-provider', 'remove', 'fixture', '--json']),
      provider,
    );
    assert.deepEqual(
      await runCli(stateRoot, ['skill-source', 'remove', 'shared', '--json']),
      source,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test(
  'service core-run is a real foreground MCP server and closes gracefully on SIGTERM',
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'localink-cli-core-run-'));
    const port = await availablePort();
    const child = spawn(process.execPath, [cliEntry, 'service', 'core-run'], {
      env: {
        ...process.env,
        LOCALINK_STATE_ROOT: path.join(root, 'state'),
        LOCALINK_MCP_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let client: Client | undefined;
    try {
      const deadline = Date.now() + 8_000;
      while (client === undefined && Date.now() < deadline) {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
        );
        const candidate = new Client(
          { name: 'core-run-test', version: '1.0.0' },
          { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
        );
        try {
          await candidate.connect(transport);
          client = candidate;
        } catch {
          await transport.close().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(client !== undefined, stderr);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 27);
      const health = await client.callTool({
        name: 'localink.health_status',
        arguments: {},
      });
      assert.notEqual(health.isError, true);
      await client.close();
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) =>
        child.once('close', resolve),
      );
      assert.equal(code, 0, stderr);
    } finally {
      if (client !== undefined) await client.close().catch(() => undefined);
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  },
);
