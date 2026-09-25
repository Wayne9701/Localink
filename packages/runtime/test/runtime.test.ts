import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalinkError, type WorkspaceRecord } from '@localink/sdk';
import { writeServiceSnapshot } from '@localink/service';
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
          registeredCapabilities: 0,
          registeredCapabilitiesByTier: { 0: 0, 1: 0, 2: 0 },
          providers: [],
        },
      },
      service: { state: 'unconfigured', stale: true },
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

test('running runtime refreshes external workspace add/remove and preserves latest records on mutation', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const firstRoot = path.join(root, 'first');
    const secondRoot = path.join(root, 'second');
    const thirdRoot = path.join(root, 'third');
    await Promise.all(
      [firstRoot, secondRoot, thirdRoot].map((directory) => mkdir(directory)),
    );
    await writeFile(path.join(firstRoot, 'sample.txt'), 'external workspace\n');
    const running = await createLocalinkRuntime({ stateRoot });
    const cli = await createLocalinkRuntime({ stateRoot });
    try {
      assert.equal((await running.health()).workspaceCount, 0);
      const first = await cli.addWorkspace('first', firstRoot);
      await running.refreshWorkspaces();
      assert.equal(running.native.workspaceInspect(first.id).name, 'first');
      assert.equal(running.native.workspaceList().length, 1);
      assert.equal(
        (await running.files.readText(first.id, 'sample.txt', 1024)).text,
        'external workspace\n',
      );
      assert.equal((await running.health()).workspaceCount, 1);

      const second = await running.addWorkspace('second', secondRoot);
      assert.deepEqual(
        cli.workspaces.list().map((item) => item.id),
        [first.id],
      );
      await cli.refreshWorkspaces();
      assert.deepEqual(
        cli.workspaces
          .list()
          .map((item) => item.id)
          .sort(),
        [first.id, second.id].sort(),
      );
      await cli.removeWorkspace(first.id);
      await running.refreshWorkspaces();
      assert.deepEqual(
        running.workspaces.list().map((item) => item.id),
        [second.id],
      );
      assert.throws(
        () => running.native.workspaceInspect(first.id),
        hasCode('NOT_FOUND'),
      );

      const third = await cli.addWorkspace('third', thirdRoot);
      await running.removeWorkspace(second.id);
      await cli.refreshWorkspaces();
      assert.deepEqual(
        cli.workspaces.list().map((item) => item.id),
        [third.id],
      );
      assert.equal((await running.health()).workspaceCount, 1);

      const configPath = path.join(stateRoot, 'config', 'workspaces.json');
      await writeFile(configPath, '{bad json');
      await assert.rejects(
        running.refreshWorkspaces(),
        hasCode('CONFIG_INVALID'),
      );
      assert.deepEqual(
        running.workspaces.list().map((item) => item.id),
        [third.id],
      );
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          workspaces: [
            third,
            { ...third, id: 'missing-root', root: path.join(root, 'missing') },
          ],
        }),
      );
      await assert.rejects(running.refreshWorkspaces(), hasCode('NOT_FOUND'));
      assert.deepEqual(
        running.workspaces.list().map((item) => item.id),
        [third.id],
      );
    } finally {
      await Promise.all([running.close(), cli.close()]);
    }
  });
});

test('running runtime refreshes external process policy and retains last valid policy on malformed config', async () => {
  await withTemp(async (root) => {
    const stateRoot = path.join(root, 'state');
    const running = await createLocalinkRuntime({ stateRoot });
    const cli = await createLocalinkRuntime({ stateRoot });
    try {
      assert.equal(running.processPolicy().enabled, false);
      await cli.setProcessEnabled(true);
      await running.refreshProcessPolicy();
      assert.equal(running.native.processPolicy().enabled, true);
      assert.equal((await running.health()).processPolicy.enabled, true);
      await cli.setProcessEnabled(false);
      assert.equal((await running.health()).processPolicy.enabled, false);
      await writeFile(
        path.join(stateRoot, 'config', 'process-policy.json'),
        '{bad json',
      );
      await assert.rejects(
        running.refreshProcessPolicy(),
        hasCode('CONFIG_INVALID'),
      );
      assert.equal(running.processPolicy().enabled, false);
    } finally {
      await Promise.all([running.close(), cli.close()]);
    }
  });
});

test('runtime health reads the latest sanitized service snapshot and marks stale state', async () => {
  await withTemp(async (root) => {
    const checkedAt = '2026-09-20T00:00:00.000Z';
    await writeServiceSnapshot(root, {
      version: 1,
      checkedAt,
      core: {
        installed: true,
        processRunning: true,
        readiness: 'ready',
        reasonCodes: [],
      },
      localMcpReadiness: 'ready',
      tunnel: {
        configured: false,
        secretAvailable: false,
        installed: false,
        processRunning: false,
        binaryAvailable: true,
        versionCompatibility: 'tested',
        profileValid: 'unknown',
        controlPlaneAuth: 'unknown',
        connected: 'unknown',
        ready: 'unknown',
        reasonCodes: ['TUNNEL_NOT_CONFIGURED'],
      },
      recovery: { installed: true, lastAction: 'none' },
      clientBinding: { state: 'not_observable' },
    });
    const runtime = await createLocalinkRuntime({ stateRoot: root });
    const service = (await runtime.health()).service;
    assert.equal(
      'checkedAt' in service ? service.checkedAt : undefined,
      checkedAt,
    );
    assert.equal(service.stale, true);
    assert.equal(JSON.stringify(service).includes(root), false);
    await runtime.close();
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
