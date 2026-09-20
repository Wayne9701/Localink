import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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

test('tool registry is exact 21 with centralized conservative annotations and no public env', () => {
  assert.equal(TOOL_NAMES.length, 21);
  assert.equal(new Set(TOOL_NAMES).size, 21);
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

test('official SDK stdio and HTTP expose and call the same exact 21 product tools', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-product-native-'));
  const stateRoot = path.join(root, 'state');
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot);
  await writeFile(path.join(workspaceRoot, 'transport.txt'), 'transport-ok');
  const setup = await createLocalinkRuntime({ stateRoot });
  const workspace = await setup.addWorkspace('transport', workspaceRoot);
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
