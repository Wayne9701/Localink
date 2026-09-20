import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { LocalinkError } from '@localink/sdk';
import { withFixture } from './helpers.js';

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof LocalinkError && error.code === code;
}

test('workspace register, list, inspect, resolve, and remove registration', async () => {
  await withFixture(async (fixture) => {
    const record = fixture.workspaces.inspect(fixture.workspaceId);
    assert.equal(record.name, 'fixture');
    assert.equal(fixture.workspaces.list().length, 1);
    assert.equal(record.id.includes(fixture.workspaceRoot), false);

    await mkdir(path.join(fixture.workspaceRoot, 'nested'));
    await writeFile(
      path.join(fixture.workspaceRoot, 'nested', 'value.txt'),
      'ok',
    );
    const resolved = await fixture.workspaces.resolve(
      fixture.workspaceId,
      'nested/value.txt',
    );
    assert.equal(resolved.exists, true);
    assert.equal(await readFile(resolved.absolutePath, 'utf8'), 'ok');

    fixture.workspaces.remove(fixture.workspaceId);
    assert.equal(fixture.workspaces.list().length, 0);
    assert.equal(
      await readFile(
        path.join(fixture.workspaceRoot, 'nested', 'value.txt'),
        'utf8',
      ),
      'ok',
    );
    assert.throws(
      () => fixture.workspaces.inspect(fixture.workspaceId),
      hasCode('NOT_FOUND'),
    );
  });
});

test('workspace resolver blocks traversal, absolute replacement, and NUL', async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      fixture.workspaces.resolve(fixture.workspaceId, '../outside'),
      hasCode('PATH_OUTSIDE_WORKSPACE'),
    );
    await assert.rejects(
      fixture.workspaces.resolve(fixture.workspaceId, '/tmp/outside'),
      hasCode('PATH_OUTSIDE_WORKSPACE'),
    );
    await assert.rejects(
      fixture.workspaces.resolve(fixture.workspaceId, 'bad\0path'),
      hasCode('INVALID_ARGUMENT'),
    );
  });
});

test('workspace resolver blocks outside symlinks and permits internal symlinks', async () => {
  await withFixture(async (fixture) => {
    const outside = path.join(fixture.root, 'outside');
    const inside = path.join(fixture.workspaceRoot, 'inside');
    await mkdir(outside);
    await mkdir(inside);
    await symlink(outside, path.join(fixture.workspaceRoot, 'outside-link'));
    await symlink(inside, path.join(fixture.workspaceRoot, 'inside-link'));

    await assert.rejects(
      fixture.workspaces.resolve(fixture.workspaceId, 'outside-link/file.txt'),
      hasCode('SYMLINK_ESCAPE'),
    );
    const internal = await fixture.workspaces.resolve(
      fixture.workspaceId,
      'inside-link/new/file.txt',
    );
    assert.equal(internal.exists, false);
    assert.equal(internal.absolutePath.startsWith(inside), true);
  });
});

test('nonexistent destination validates nearest existing canonical parent', async () => {
  await withFixture(async (fixture) => {
    await mkdir(path.join(fixture.workspaceRoot, 'safe'));
    const resolved = await fixture.workspaces.resolve(
      fixture.workspaceId,
      'safe/new/deep/file.txt',
    );
    assert.equal(resolved.exists, false);
    assert.equal(
      resolved.absolutePath,
      path.join(fixture.workspaceRoot, 'safe/new/deep/file.txt'),
    );
  });
});

test('workspace registry restores persisted identity and rejects duplicate ID or canonical root', async () => {
  await withFixture(async (fixture) => {
    const source = fixture.workspaces.inspect(fixture.workspaceId);
    const restoredRegistry = new (
      await import('../src/workspace/workspace-registry.js')
    ).WorkspaceRegistry();
    const restored = await restoredRegistry.restore(source);
    assert.deepEqual(restored, source);
    await assert.rejects(
      restoredRegistry.restore(source),
      hasCode('ALREADY_EXISTS'),
    );
    await assert.rejects(
      restoredRegistry.restore({ ...source, id: 'different-id' }),
      hasCode('ALREADY_EXISTS'),
    );
  });
});
