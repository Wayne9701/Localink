import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessManager, WorkspaceRegistry } from '@localink/core';

const fixture = await mkdtemp(path.join(tmpdir(), 'localink-process-smoke-'));
try {
  const workspaceRoot = path.join(fixture, 'workspace');
  await mkdir(workspaceRoot);
  const workspaces = new WorkspaceRegistry();
  const workspace = await workspaces.register('process-smoke', workspaceRoot);
  const processes = new ProcessManager(workspaces);
  const started = await processes.start({
    command: process.execPath,
    args: [
      '-e',
      "process.stdin.on('data', data => process.stdout.write('echo:' + data)); setInterval(() => undefined, 1000)",
    ],
    workspaceId: workspace.id,
  });
  await processes.input(started.processId, 'ready\n');
  let observed = processes.poll(started.processId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (observed.stdout.text.includes('echo:ready')) break;
    await delay(20);
    observed = processes.poll(started.processId);
  }
  assert.equal(observed.stdout.text.includes('echo:ready'), true);
  const stopped = await processes.stop({
    processId: started.processId,
    graceMs: 1000,
    forceKill: true,
  });
  assert.equal(stopped.state, 'stopped');
  process.stdout.write(
    `${JSON.stringify({ ok: true, started, stopped }, null, 2)}\n`,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
