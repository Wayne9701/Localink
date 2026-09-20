import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { LocalinkError, type ProcessReceipt } from '@localink/sdk';
import { ProcessManager } from '../src/index.js';
import { withFixture } from './helpers.js';

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof LocalinkError && error.code === code;
}

async function waitFor(
  poll: () => ProcessReceipt,
  predicate: (receipt: ProcessReceipt) => boolean,
): Promise<ProcessReceipt> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = poll();
    if (predicate(receipt)) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('process condition did not become true');
}

test('buffered exec captures stdout, stderr, exit code, env, and cwd', async () => {
  await withFixture(async ({ workspaces, workspaceId, workspaceRoot }) => {
    await mkdir(path.join(workspaceRoot, 'nested'));
    const processes = new ProcessManager(workspaces);
    const receipt = await processes.exec({
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write(process.env.LOCALINK_TEST); process.stderr.write('warn'); process.exit(7)",
      ],
      workspaceId,
      cwd: 'nested',
      env: { LOCALINK_TEST: 'ok' },
    });
    assert.equal(receipt.stdout.text, 'ok');
    assert.equal(receipt.stderr.text, 'warn');
    assert.equal(receipt.exitCode, 7);
    assert.equal(receipt.state, 'exited');
    assert.equal(receipt.cwd, path.join(workspaceRoot, 'nested'));
  });
});

test('buffered exec times out and bounds captured output', async () => {
  await withFixture(async ({ workspaces, workspaceId }) => {
    const processes = new ProcessManager(workspaces);
    const truncated = await processes.exec({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(200))"],
      workspaceId,
      maxOutputBytes: 32,
    });
    assert.equal(truncated.stdout.text.length, 32);
    assert.equal(truncated.stdout.byteLength, 200);
    assert.equal(truncated.stdout.truncated, true);

    const timedOut = await processes.exec({
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      workspaceId,
      timeoutMs: 50,
    });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.state, 'stopped');
  });
});

test('persistent process supports poll, stdin, stop, and deterministic repeated stop', async () => {
  await withFixture(async ({ workspaces, workspaceId }) => {
    const processes = new ProcessManager(workspaces);
    const started = await processes.start({
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.on('data', data => process.stdout.write('got:' + data)); setInterval(() => undefined, 1000)",
      ],
      workspaceId,
    });
    assert.equal(started.state, 'running');
    await processes.input(started.processId, 'ping\n');
    const withOutput = await waitFor(
      () => processes.poll(started.processId),
      (receipt) => receipt.stdout.text.includes('got:ping'),
    );
    assert.equal(withOutput.state, 'running');
    const stopped = await processes.stop({
      processId: started.processId,
      graceMs: 1000,
      forceKill: true,
    });
    assert.equal(stopped.state, 'stopped');
    const repeated = await processes.stop({ processId: started.processId });
    assert.equal(repeated.state, 'stopped');
    assert.equal(repeated.endedAt, stopped.endedAt);
  });
});

test('process IDs are local-only and workspace cwd cannot escape', async () => {
  await withFixture(async ({ workspaces, workspaceId }) => {
    const processes = new ProcessManager(workspaces);
    assert.throws(
      () => processes.poll('not-a-process'),
      hasCode('PROCESS_NOT_FOUND'),
    );
    await assert.rejects(
      processes.exec({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        workspaceId,
        cwd: '../outside',
      }),
      hasCode('PATH_OUTSIDE_WORKSPACE'),
    );
    await assert.rejects(
      processes.exec({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        workspaceId,
        cwd: 'missing',
      }),
      hasCode('NOT_FOUND'),
    );
  });
});
