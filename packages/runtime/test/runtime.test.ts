import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalinkError, type WorkspaceRecord } from '@localink/sdk';
import {
  WORKSPACE_SCHEMA_VERSION,
  createLocalinkRuntime,
  type WorkspaceConfig,
  type WorkspaceConfigStore,
} from '../src/index.js';

async function withTemp(
  worker: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-runtime-test-'));
  try {
    await worker(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof LocalinkError && error.code === code;
}

test('fresh runtime persists stable canonical workspace identity across restart and remove', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const workspaceInput = path.join(root, 'workspace-link');
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot);
    const { symlink } = await import('node:fs/promises');
    await symlink(workspaceRoot, workspaceInput);

    const first = await createLocalinkRuntime({ stateRoot });
    assert.deepEqual(await first.health(), {
      mode: 'runtime',
      version: '0.1.0',
      workspaceCount: 0,
      capabilityCount: 0,
      skillCount: 0,
      state: { ready: true, schemaVersion: 1 },
      processPolicy: { enabled: false, shell: false, osSandbox: false },
      sharedAssets: {
        skillSources: { configured: 0, loadedSkills: 0, degraded: 0 },
        externalMcp: {
          providerCount: 0,
          readyProviders: 0,
          degradedProviders: 0,
          registeredReadCapabilities: 0,
          providers: [],
        },
      },
    });
    const added = await first.addWorkspace('primary', workspaceInput);
    assert.equal(added.root, await realpath(workspaceRoot));
    await first.close();

    const restarted = await createLocalinkRuntime({ stateRoot });
    assert.deepEqual(restarted.workspaces.inspect(added.id), added);
    assert.equal((await restarted.health()).workspaceCount, 1);
    const removed = await restarted.removeWorkspace(added.id);
    assert.deepEqual(removed, added);
    await restarted.close();

    const finalRuntime = await createLocalinkRuntime({ stateRoot });
    assert.deepEqual(finalRuntime.workspaces.list(), []);
    await finalRuntime.close();
  });
});

test('separate state roots remain isolated', async () => {
  await withTemp(async (root) => {
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot);
    const left = await createLocalinkRuntime({
      stateRoot: path.join(root, 'left'),
    });
    const right = await createLocalinkRuntime({
      stateRoot: path.join(root, 'right'),
    });
    await left.addWorkspace('left', workspaceRoot);
    assert.equal(left.workspaces.list().length, 1);
    assert.equal(right.workspaces.list().length, 0);
    await Promise.all([left.close(), right.close()]);
  });
});

test('malformed, structurally invalid, missing-root, and duplicate persisted config fail visibly', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const configPath = path.join(stateRoot, 'config', 'workspaces.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{bad json');
    await assert.rejects(
      createLocalinkRuntime({ stateRoot }),
      hasCode('CONFIG_INVALID'),
    );

    await writeFile(configPath, JSON.stringify({ version: 2, workspaces: [] }));
    await assert.rejects(
      createLocalinkRuntime({ stateRoot }),
      hasCode('CONFIG_INVALID'),
    );

    const missing: WorkspaceRecord = {
      id: 'missing-root',
      name: 'missing',
      root: path.join(root, 'missing'),
      createdAt: '2026-09-20T00:00:00.000Z',
    };
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, workspaces: [missing] }),
    );
    await assert.rejects(
      createLocalinkRuntime({ stateRoot }),
      hasCode('NOT_FOUND'),
    );

    const invalidRoot = path.join(root, 'not-a-directory');
    await writeFile(invalidRoot, 'file');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        workspaces: [{ ...missing, id: 'invalid-root', root: invalidRoot }],
      }),
    );
    await assert.rejects(
      createLocalinkRuntime({ stateRoot }),
      hasCode('INVALID_ARGUMENT'),
    );

    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot);
    const duplicateRoot = [
      { ...missing, id: 'one', root: workspaceRoot },
      { ...missing, id: 'two', root: workspaceRoot },
    ];
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, workspaces: duplicateRoot }),
    );
    await assert.rejects(
      createLocalinkRuntime({ stateRoot }),
      hasCode('ALREADY_EXISTS'),
    );

    const duplicateId = [
      { ...missing, id: 'same', root: workspaceRoot },
      { ...missing, id: 'same', root: path.join(root, 'workspace-2') },
    ];
    await mkdir(duplicateId[1]!.root);
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, workspaces: duplicateId }),
    );
    await assert.rejects(
      createLocalinkRuntime({ stateRoot }),
      hasCode('ALREADY_EXISTS'),
    );
  });
});

test('failed persistence rolls back add and prevents remove from changing memory', async () => {
  await withTemp(async (root) => {
    const workspaceRoot = path.join(root, 'workspace');
    await mkdir(workspaceRoot);
    const persistence: { value?: WorkspaceConfig } = {};
    let failWrites = true;
    const store: WorkspaceConfigStore = {
      async read() {
        return persistence.value;
      },
      async write(value) {
        if (failWrites) {
          throw new LocalinkError('IO_ERROR', 'Injected persistence failure.');
        }
        persistence.value = structuredClone(value);
        return structuredClone(value);
      },
    };
    const runtime = await createLocalinkRuntime({
      stateRoot: path.join(root, 'unused'),
      workspaceStore: store,
    });
    await assert.rejects(
      runtime.addWorkspace('failed', workspaceRoot),
      hasCode('IO_ERROR'),
    );
    assert.deepEqual(runtime.workspaces.list(), []);
    assert.equal(persistence.value, undefined);

    failWrites = false;
    const added = await runtime.addWorkspace('kept', workspaceRoot);
    assert.equal(
      (persistence.value as WorkspaceConfig | undefined)?.version,
      WORKSPACE_SCHEMA_VERSION,
    );
    failWrites = true;
    await assert.rejects(
      runtime.removeWorkspace(added.id),
      hasCode('IO_ERROR'),
    );
    assert.deepEqual(runtime.workspaces.inspect(added.id), added);
    assert.equal(
      (persistence.value as WorkspaceConfig | undefined)?.workspaces.length,
      1,
    );
    await runtime.close();
  });
});

test('environment state root is honored and health never exposes private paths', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'environment-state');
    const runtime = await createLocalinkRuntime({
      environment: { LOCALINK_STATE_ROOT: stateRoot },
    });
    assert.equal(runtime.statePaths.root, stateRoot);
    assert.equal(JSON.stringify(await runtime.health()).includes(root), false);
    await runtime.close();
    assert.equal((await runtime.health()).state.ready, false);
  });
});

test('process policy defaults disabled, validates schema, and persists across runtime restart', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const first = await createLocalinkRuntime({ stateRoot });
    assert.deepEqual(first.processPolicy(), { version: 1, enabled: false });
    assert.deepEqual(await first.setProcessEnabled(true), {
      version: 1,
      enabled: true,
    });
    await first.close();

    const restarted = await createLocalinkRuntime({ stateRoot });
    assert.deepEqual(restarted.processPolicy(), { version: 1, enabled: true });
    await restarted.close();

    await writeFile(
      path.join(stateRoot, 'config', 'process-policy.json'),
      JSON.stringify({ version: 2, enabled: true }),
    );
    await assert.rejects(
      createLocalinkRuntime({ stateRoot }),
      hasCode('CONFIG_INVALID'),
    );
  });
});
