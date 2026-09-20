import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
