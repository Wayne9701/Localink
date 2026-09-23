import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLocalinkRuntime } from '@localink/runtime';
import { PublicAdapter } from '../src/public-adapter.js';
import { createPublicServer } from '../src/server.js';
import {
  PUBLIC_FILE_LIMITS,
  PUBLIC_PROCESS_LIMITS,
  TOOL_NAMES,
  toolAnnotations,
  toolSchemas,
} from '../src/tool-definitions.js';
import { startHttpServer } from '../src/http.js';
import {
  at,
  call,
  envelope,
  httpClient,
  stdioClientForStateRoot,
} from './helpers.js';

const SYNTHETIC_SECRET = 'synthetic-not-a-real-secret';
const run = promisify(execFile);
const externalStdioFixture = fileURLToPath(
  new URL(
    '../../../runtime/dist/test/external-mcp-stdio-fixture.js',
    import.meta.url,
  ),
);

async function withNative(
  worker: (fixture: {
    root: string;
    stateRoot: string;
    workspaceRoot: string;
    workspaceId: string;
    runtime: Awaited<ReturnType<typeof createLocalinkRuntime>>;
    adapter: PublicAdapter;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-native-test-'));
  const stateRoot = path.join(root, 'state');
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot);
  const runtime = await createLocalinkRuntime({
    stateRoot,
    environment: {
      ...process.env,
      LOCALINK_TEST_SECRET: SYNTHETIC_SECRET,
    },
  });
  try {
    const workspace = await runtime.addWorkspace('native-test', workspaceRoot);
    await worker({
      root,
      stateRoot,
      workspaceRoot,
      workspaceId: workspace.id,
      runtime,
      adapter: new PublicAdapter(runtime),
    });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function invoke(
  adapter: PublicAdapter,
  name: string,
  args: Record<string, unknown>,
) {
  return envelope(await adapter.call(`localink.${name}`, args));
}

test('tool registry is exact 26 with centralized conservative annotations and no public env', () => {
  assert.equal(TOOL_NAMES.length, 26);
  assert.equal(new Set(TOOL_NAMES).size, 26);
  assert.equal(toolAnnotations['localink.files_read_many'].readOnlyHint, true);
  assert.equal(toolAnnotations['localink.files_archive'].destructiveHint, true);
  assert.equal(toolAnnotations['localink.files_archive'].openWorldHint, false);
  assert.equal(toolAnnotations['localink.process_exec'].openWorldHint, true);
  assert.equal(toolAnnotations['localink.process_poll'].readOnlyHint, true);
  assert.equal(
    JSON.stringify(toolSchemas['localink.process_exec']).includes('env'),
    false,
  );
  assert.equal(
    JSON.stringify(toolSchemas['localink.process_start']).includes('env'),
    false,
  );
  assert.equal(createPublicServer.length >= 1, true);
});

test('running public workspace, Files, Git, and Process tools refresh external workspace config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-cross-process-'));
  const stateRoot = path.join(root, 'state');
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot);
  await writeFile(path.join(workspaceRoot, 'sample.txt'), 'fresh-needle\n');
  await run('git', ['init', '-q'], { cwd: workspaceRoot });
  const running = await createLocalinkRuntime({ stateRoot });
  const cli = await createLocalinkRuntime({ stateRoot });
  const adapter = new PublicAdapter(running);
  try {
    assert.equal(
      (
        at(
          await invoke(adapter, 'workspace_list', {}),
          'data',
          'workspaces',
        ) as unknown[]
      ).length,
      0,
    );
    const workspace = await cli.addWorkspace('cross-process', workspaceRoot);
    const listed = await invoke(adapter, 'workspace_list', {});
    assert.equal((at(listed, 'data', 'workspaces') as unknown[]).length, 1);
    assert.equal(JSON.stringify(listed).includes(root), false);
    assert.equal(
      at(
        await invoke(adapter, 'workspace_inspect', {
          workspaceId: workspace.id,
        }),
        'data',
        'name',
      ),
      'cross-process',
    );
    const read = await invoke(adapter, 'files_read_many', {
      workspaceId: workspace.id,
      paths: ['sample.txt'],
    });
    const items = at(read, 'data', 'items') as Record<string, unknown>[];
    assert.equal(at(items[0], 'value', 'text'), 'fresh-needle\n');
    const git = await invoke(adapter, 'git_status', {
      workspaceId: workspace.id,
    });
    assert.equal(
      (at(git, 'data', 'entries') as Record<string, unknown>[]).some(
        (entry) => entry.path === 'sample.txt',
      ),
      true,
    );
    await running.setProcessEnabled(true);
    const processResult = await invoke(adapter, 'process_exec', {
      workspaceId: workspace.id,
      command: process.execPath,
      args: ['-e', "process.stdout.write('fresh-process')"],
    });
    assert.equal(at(processResult, 'data', 'stdout', 'text'), 'fresh-process');
    await cli.removeWorkspace(workspace.id);
    assert.equal(
      (
        at(
          await invoke(adapter, 'workspace_list', {}),
          'data',
          'workspaces',
        ) as unknown[]
      ).length,
      0,
    );
    const configPath = path.join(stateRoot, 'config', 'workspaces.json');
    await writeFile(configPath, '{bad json');
    const invalid = await invoke(adapter, 'workspace_list', {});
    assert.equal(at(invalid, 'data', 'error', 'code'), 'CONFIG_INVALID');
    assert.equal(JSON.stringify(invalid).includes(root), false);
  } finally {
    await Promise.all([running.close(), cli.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace and file tools are public-safe, bounded, partial-failure tolerant and verifiable', async () => {
  await withNative(async ({ adapter, root, workspaceId, workspaceRoot }) => {
    await writeFile(path.join(workspaceRoot, 'alpha.txt'), 'needle alpha\n');
    await writeFile(
      path.join(workspaceRoot, 'binary.bin'),
      Buffer.from([0, 1, 2]),
    );
    await writeFile(
      path.join(workspaceRoot, 'oversize.txt'),
      'x'.repeat(PUBLIC_FILE_LIMITS.defaultReadBytes + 1),
    );

    for (const result of [
      await invoke(adapter, 'workspace_list', {}),
      await invoke(adapter, 'workspace_inspect', { workspaceId }),
    ]) {
      assert.equal(JSON.stringify(result).includes(root), false);
      assert.equal(JSON.stringify(result).includes('"root":'), false);
    }

    const listed = await invoke(adapter, 'files_list', { workspaceId });
    assert.equal((at(listed, 'data', 'entries') as unknown[]).length, 3);

    const read = await invoke(adapter, 'files_read_many', {
      workspaceId,
      paths: ['alpha.txt', 'missing.txt', 'binary.bin', 'oversize.txt'],
    });
    const readItems = at(read, 'data', 'items') as Record<string, unknown>[];
    assert.deepEqual(
      readItems.map((item) => item.path),
      ['alpha.txt', 'missing.txt', 'binary.bin', 'oversize.txt'],
    );
    assert.deepEqual(
      readItems.map((item) => item.ok),
      [true, false, false, false],
    );
    assert.equal(at(readItems[1], 'error', 'code'), 'NOT_FOUND');
    assert.equal(at(readItems[2], 'error', 'code'), 'BINARY_NOT_SUPPORTED');
    assert.equal(at(readItems[3], 'error', 'code'), 'SIZE_LIMIT_EXCEEDED');
    assert.equal(JSON.stringify(read).includes(root), false);

    const inspected = await invoke(adapter, 'files_inspect_many', {
      workspaceId,
      paths: ['alpha.txt', 'missing.txt'],
      includeSha256: true,
    });
    const inspectItems = at(inspected, 'data', 'items') as Record<
      string,
      unknown
    >[];
    assert.equal(at(inspectItems[0], 'value', 'kind'), 'file');
    assert.equal(typeof at(inspectItems[0], 'value', 'sha256'), 'string');
    assert.equal(inspectItems[1]?.ok, false);

    for (const mode of ['path', 'content'] as const) {
      const found = await invoke(adapter, 'files_search', {
        workspaceId,
        query: mode === 'path' ? 'alpha' : 'needle',
        mode,
      });
      assert.equal((at(found, 'data', 'matches') as unknown[]).length, 1);
    }

    const created = await invoke(adapter, 'files_create_text', {
      workspaceId,
      relativePath: 'created.txt',
      text: 'before\n',
    });
    const sha256 = at(created, 'data', 'sha256');
    assert.equal(typeof sha256, 'string');
    assert.equal(
      at(
        await invoke(adapter, 'files_create_text', {
          workspaceId,
          relativePath: 'created.txt',
          text: 'overwrite',
        }),
        'data',
        'error',
        'code',
      ),
      'ALREADY_EXISTS',
    );
    assert.equal(
      at(
        await invoke(adapter, 'files_precise_edit', {
          workspaceId,
          relativePath: 'created.txt',
          expectedText: 'before',
          replacementText: 'after',
          expectedSha256: '0'.repeat(64),
        }),
        'data',
        'error',
        'code',
      ),
      'STALE_PRECONDITION',
    );
    const edited = await invoke(adapter, 'files_precise_edit', {
      workspaceId,
      relativePath: 'created.txt',
      expectedText: 'before',
      replacementText: 'after',
      expectedSha256: sha256,
      expectedOccurrences: 1,
    });
    assert.equal(at(edited, 'data', 'occurrences'), 1);
    const moved = await invoke(adapter, 'files_move', {
      workspaceId,
      sourceRelativePath: 'created.txt',
      destinationRelativePath: 'moved.txt',
    });
    assert.equal(at(moved, 'data', 'destination'), 'moved.txt');
    const archived = await invoke(adapter, 'files_archive', {
      workspaceId,
      relativePath: 'moved.txt',
    });
    assert.equal(at(archived, 'data', 'archived'), true);
    assert.equal(JSON.stringify(archived).includes('archivePath'), false);
    assert.equal(JSON.stringify(archived).includes(root), false);

    for (const [name, args] of [
      ['files_read_many', { workspaceId, paths: Array(21).fill('alpha.txt') }],
      [
        'files_inspect_many',
        { workspaceId, paths: Array(51).fill('alpha.txt') },
      ],
      [
        'files_read_many',
        {
          workspaceId,
          paths: ['alpha.txt'],
          maxBytesPerFile: PUBLIC_FILE_LIMITS.hardReadBytes + 1,
        },
      ],
    ] as const) {
      assert.equal(
        at(await invoke(adapter, name, args), 'data', 'error', 'code'),
        'INVALID_ARGUMENT',
      );
    }
  });
});

test('process policy defaults disabled; enabled lifecycle sanitizes env and public receipts', async () => {
  await withNative(async ({ adapter, root, runtime, workspaceId }) => {
    const denied = await invoke(adapter, 'process_exec', {
      workspaceId,
      command: process.execPath,
      args: ['-e', "process.stdout.write('should-not-run')"],
    });
    assert.equal(at(denied, 'data', 'error', 'code'), 'POLICY_DENIED');
    assert.equal(runtime.processes.list().length, 0);
    await runtime.setProcessEnabled(true);

    const executed = await invoke(adapter, 'process_exec', {
      workspaceId,
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write(process.env.LOCALINK_TEST_SECRET ?? 'missing')",
      ],
      timeoutMs: 10_000,
    });
    assert.equal(at(executed, 'data', 'stdout', 'text'), 'missing');
    assert.equal(JSON.stringify(executed).includes(SYNTHETIC_SECRET), false);
    assert.equal(JSON.stringify(executed).includes('hostPid'), false);
    assert.equal(JSON.stringify(executed).includes('cwd'), false);
    assert.equal(JSON.stringify(executed).includes(root), false);

    const started = await invoke(adapter, 'process_start', {
      workspaceId,
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.on('data', data => process.stdout.write('got:' + data)); setInterval(() => undefined, 1000)",
      ],
    });
    const processId = String(at(started, 'data', 'processId'));
    await invoke(adapter, 'process_input', { processId, data: 'ping\n' });
    let polled = await invoke(adapter, 'process_poll', { processId });
    for (
      let attempt = 0;
      attempt < 100 &&
      !String(at(polled, 'data', 'stdout', 'text')).includes('got:ping');
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      polled = await invoke(adapter, 'process_poll', { processId });
    }
    assert.match(String(at(polled, 'data', 'stdout', 'text')), /got:ping/u);
    const stopped = await invoke(adapter, 'process_stop', {
      processId,
      graceMs: 1000,
      forceKill: true,
    });
    assert.equal(at(stopped, 'data', 'state'), 'stopped');

    assert.equal(
      at(
        await invoke(adapter, 'process_exec', {
          workspaceId,
          command: process.execPath,
          env: { INJECTED: 'blocked' },
        }),
        'data',
        'error',
        'code',
      ),
      'INVALID_ARGUMENT',
    );
    assert.equal(
      at(
        await invoke(adapter, 'process_exec', {
          workspaceId,
          command: process.execPath,
          timeoutMs: PUBLIC_PROCESS_LIMITS.hardExecTimeoutMs + 1,
        }),
        'data',
        'error',
        'code',
      ),
      'INVALID_ARGUMENT',
    );
  });
});

test('runtime close terminates managed children deterministically', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-close-test-'));
  try {
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot);
    const runtime = await createLocalinkRuntime({
      stateRoot: path.join(root, 'state'),
    });
    const workspace = await runtime.addWorkspace('close-test', workspaceRoot);
    await runtime.setProcessEnabled(true);
    await runtime.native.processStart({
      workspaceId: workspace.id,
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
    });
    assert.equal(runtime.processes.list()[0]?.state, 'running');
    await Promise.all([runtime.close(), runtime.close()]);
    assert.deepEqual(runtime.processes.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official SDK stdio and HTTP expose and call the same exact 26 product tools', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-product-native-'));
  const stateRoot = path.join(root, 'state');
  const workspaceRoot = path.join(root, 'workspace');
  const skillsRoot = path.join(root, 'skills');
  await mkdir(workspaceRoot);
  await mkdir(path.join(skillsRoot, 'transport-skill'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'transport.txt'), 'transport-ok');
  await writeFile(
    path.join(skillsRoot, 'transport-skill', 'SKILL.md'),
    '---\nname: Transport Skill\ndescription: Real configured test skill.\n---\n# Transport\n',
  );
  const setup = await createLocalinkRuntime({ stateRoot });
  const workspace = await setup.addWorkspace('transport', workspaceRoot);
  await setup.addSkillSource('shared', skillsRoot);
  await setup.addStdioProvider('fixture', process.execPath, [
    externalStdioFixture,
    path.join(root, 'provider.pid'),
  ]);
  await setup.close();

  const stdio = await stdioClientForStateRoot(stateRoot, true);
  t.after(() => stdio.client.close());
  const stdioTools = await stdio.client.listTools();
  assert.deepEqual(
    stdioTools.tools.map((tool) => tool.name),
    TOOL_NAMES,
  );
  for (const name of ['localink.process_exec', 'localink.process_start']) {
    const tool = stdioTools.tools.find((item) => item.name === name);
    assert.equal(JSON.stringify(tool?.inputSchema).includes('"env"'), false);
  }
  const stdioRead = await call(stdio.client, 'files_read_many', {
    workspaceId: workspace.id,
    paths: ['transport.txt'],
  });
  const stdioItems = at(stdioRead, 'data', 'items') as Record<
    string,
    unknown
  >[];
  assert.equal(at(stdioItems[0], 'value', 'text'), 'transport-ok');
  const skillSearch = await call(stdio.client, 'skill_search', {
    query: 'Transport Skill',
  });
  assert.equal((at(skillSearch, 'data', 'items') as unknown[]).length, 1);
  const skillRead = await call(stdio.client, 'skill_read', {
    skillId: 'skill.shared.transport-skill',
  });
  assert.equal(at(skillRead, 'data', 'trust'), 'untrusted-asset');
  assert.equal(JSON.stringify(skillRead).includes(skillsRoot), false);
  const capabilitySearch = await call(stdio.client, 'capability_search', {
    query: 'fixture_read',
  });
  const capabilityItems = at(capabilitySearch, 'data', 'items') as Record<
    string,
    unknown
  >[];
  assert.equal(capabilityItems.length, 1);
  const capabilityId = String(capabilityItems[0]?.id);
  const capabilityDescription = await call(
    stdio.client,
    'capability_describe',
    { capabilityId },
  );
  assert.equal(at(capabilityDescription, 'data', 'riskTier'), 0);
  assert.equal(at(capabilityDescription, 'data', 'operationClass'), 'read');
  const capabilityInvoke = await call(stdio.client, 'capability_invoke', {
    capabilityId,
    input: { value: 'public-bridge-ok' },
  });
  assert.equal(at(capabilityInvoke, 'data', 'status'), 'executed');
  const boundedProviderResult = await call(stdio.client, 'capability_invoke', {
    capabilityId,
    input: { value: 'large' },
  });
  assert.equal(at(boundedProviderResult, 'truncation', 'truncated'), true);
  const assetHealth = await call(stdio.client, 'health_status');
  assert.equal(
    at(
      assetHealth,
      'data',
      'sharedAssets',
      'externalMcp',
      'registeredReadCapabilities',
    ),
    1,
  );
  assert.equal(
    JSON.stringify(assetHealth).includes(externalStdioFixture),
    false,
  );
  assert.equal(JSON.stringify(assetHealth).includes(skillsRoot), false);
  const safeProviderFailure = await call(stdio.client, 'capability_invoke', {
    capabilityId,
    input: { value: 'fail' },
  });
  assert.equal(
    at(safeProviderFailure, 'data', 'error', 'code'),
    'CAPABILITY_UNAVAILABLE',
  );
  assert.equal(JSON.stringify(safeProviderFailure).includes(root), false);
  await stdio.client.close();

  const runtime = await createLocalinkRuntime({ stateRoot });
  const listening = await startHttpServer({ port: 0, runtime });
  t.after(async () => {
    await listening.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const http = await httpClient(listening.url);
  t.after(() => http.client.close());
  const httpTools = await http.client.listTools();
  assert.deepEqual(
    httpTools.tools.map((tool) => tool.name),
    TOOL_NAMES,
  );
  const httpRead = await call(http.client, 'files_read_many', {
    workspaceId: workspace.id,
    paths: ['transport.txt'],
  });
  const httpItems = at(httpRead, 'data', 'items') as Record<string, unknown>[];
  assert.equal(at(httpItems[0], 'value', 'text'), 'transport-ok');
});
