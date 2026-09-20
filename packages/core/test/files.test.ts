import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { LocalinkError } from '@localink/sdk';
import { FILE_LIMITS } from '../src/index.js';
import { withFixture } from './helpers.js';

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof LocalinkError && error.code === code;
}

test('files create, list, inspect, read, replace, and no-overwrite', async () => {
  await withFixture(async ({ files, workspaceId }) => {
    const created = await files.createText(workspaceId, 'alpha.txt', 'alpha');
    assert.equal(created.byteLength, 5);
    assert.equal(
      (await files.readText(workspaceId, 'alpha.txt')).text,
      'alpha',
    );
    assert.equal((await files.inspect(workspaceId, 'alpha.txt')).kind, 'file');
    assert.deepEqual(
      (await files.list(workspaceId)).entries.map((entry) => entry.name),
      ['alpha.txt'],
    );
    await assert.rejects(
      files.createText(workspaceId, 'alpha.txt', 'again'),
      hasCode('ALREADY_EXISTS'),
    );
    await assert.rejects(
      files.list(workspaceId, '', FILE_LIMITS.hardListEntries + 1),
      hasCode('INVALID_ARGUMENT'),
    );
    const replaced = await files.replaceTextAtomic(
      workspaceId,
      'alpha.txt',
      'beta',
    );
    assert.equal(replaced.previousSha256, created.sha256);
    assert.equal((await files.readText(workspaceId, 'alpha.txt')).text, 'beta');
  });
});

test('precise edit enforces SHA and occurrence preconditions with zero writes', async () => {
  await withFixture(async ({ files, workspaceId }) => {
    const created = await files.createText(
      workspaceId,
      'edit.txt',
      'same same\n',
    );
    const staleHash = '0'.repeat(64);
    await assert.rejects(
      files.preciseEdit({
        workspaceId,
        relativePath: 'edit.txt',
        expectedText: 'same',
        replacementText: 'changed',
        expectedSha256: staleHash,
        expectedOccurrences: 2,
      }),
      hasCode('STALE_PRECONDITION'),
    );
    assert.equal(await files.sha256(workspaceId, 'edit.txt'), created.sha256);

    await assert.rejects(
      files.preciseEdit({
        workspaceId,
        relativePath: 'edit.txt',
        expectedText: 'same',
        replacementText: 'changed',
        expectedSha256: created.sha256,
        expectedOccurrences: 1,
      }),
      hasCode('EXPECTED_TEXT_MISMATCH'),
    );
    assert.equal(await files.sha256(workspaceId, 'edit.txt'), created.sha256);

    const edited = await files.preciseEdit({
      workspaceId,
      relativePath: 'edit.txt',
      expectedText: 'same',
      replacementText: 'changed',
      expectedSha256: created.sha256,
      expectedOccurrences: 2,
    });
    assert.equal(edited.occurrences, 2);
    assert.equal(
      (await files.readText(workspaceId, 'edit.txt')).text,
      'changed changed\n',
    );
  });
});

test('binary and oversize text reads fail visibly while metadata remains available', async () => {
  await withFixture(async ({ files, workspaceId, workspaceRoot }) => {
    await writeFile(
      path.join(workspaceRoot, 'binary.bin'),
      Buffer.from([0, 1, 2, 3]),
    );
    await assert.rejects(
      files.readText(workspaceId, 'binary.bin'),
      hasCode('BINARY_NOT_SUPPORTED'),
    );
    const metadata = await files.inspectBinary(workspaceId, 'binary.bin');
    assert.equal(metadata.binary, true);
    assert.equal(metadata.byteLength, 4);

    await writeFile(path.join(workspaceRoot, 'large.txt'), 'x'.repeat(32));
    await assert.rejects(
      files.readText(workspaceId, 'large.txt', 16),
      hasCode('SIZE_LIMIT_EXCEEDED'),
    );
    await assert.rejects(
      files.createText(
        workspaceId,
        'too-large.txt',
        'x'.repeat(FILE_LIMITS.hardTextBytes + 1),
      ),
      hasCode('SIZE_LIMIT_EXCEEDED'),
    );
  });
});

test('copy, move, and rename preserve hash and default to no-overwrite', async () => {
  await withFixture(async ({ files, workspaceId }) => {
    const original = await files.createText(
      workspaceId,
      'source.txt',
      'payload',
    );
    const copied = await files.copy(workspaceId, 'source.txt', 'copy.txt');
    assert.equal(copied.sha256, original.sha256);
    await assert.rejects(
      files.copy(workspaceId, 'source.txt', 'copy.txt'),
      hasCode('ALREADY_EXISTS'),
    );
    await assert.rejects(
      files.move(workspaceId, 'source.txt', 'copy.txt'),
      hasCode('ALREADY_EXISTS'),
    );
    await assert.rejects(
      files.rename(workspaceId, 'source.txt', 'copy.txt'),
      hasCode('ALREADY_EXISTS'),
    );
    const moved = await files.move(workspaceId, 'copy.txt', 'moved.txt');
    assert.equal(moved.sha256, original.sha256);
    const renamed = await files.rename(workspaceId, 'moved.txt', 'renamed.txt');
    assert.equal(renamed.sha256, original.sha256);
    await assert.rejects(
      files.readText(workspaceId, 'moved.txt'),
      hasCode('NOT_FOUND'),
    );
  });
});

test('path and content searches are deterministic and hard-bounded', async () => {
  await withFixture(async ({ files, workspaceId }) => {
    await files.createText(workspaceId, 'match-one.txt', 'needle first\n');
    await files.createText(workspaceId, 'match-two.txt', 'needle second\n');
    const paths = await files.searchPaths(workspaceId, 'match-', {
      maxMatches: 1,
    });
    assert.equal(paths.matches.length, 1);
    assert.equal(paths.truncated, true);
    const content = await files.searchContent(workspaceId, 'needle', {
      maxMatches: 2,
    });
    assert.equal(content.matches.length, 2);
    assert.deepEqual(
      content.matches.map((match) => match.line),
      [1, 1],
    );
    await assert.rejects(
      files.searchPaths(workspaceId, 'match', {
        maxMatches: FILE_LIMITS.hardSearchMatches + 1,
      }),
      hasCode('INVALID_ARGUMENT'),
    );
  });
});

test('archive removes source, verifies content, and returns an external state receipt', async () => {
  await withFixture(
    async ({ files, workspaceId, stateRoot, workspaceRoot }) => {
      const created = await files.createText(
        workspaceId,
        'archive-me.txt',
        'archive',
      );
      const receipt = await files.archive(workspaceId, 'archive-me.txt');
      assert.equal(receipt.sha256, created.sha256);
      assert.equal(receipt.archivePath.startsWith(stateRoot), true);
      assert.equal(await readFile(receipt.archivePath, 'utf8'), 'archive');
      await assert.rejects(
        access(path.join(workspaceRoot, receipt.originalRelativePath)),
      );
      await assert.rejects(
        files.readText(workspaceId, 'archive-me.txt'),
        hasCode('NOT_FOUND'),
      );
    },
  );
});

test('file operations block traversal and outside symlinks', async () => {
  await withFixture(async ({ files, workspaceId, workspaceRoot, root }) => {
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'not accessible');
    await symlink(outside, path.join(workspaceRoot, 'escape'));
    await assert.rejects(
      files.readText(workspaceId, '../outside/secret.txt'),
      hasCode('PATH_OUTSIDE_WORKSPACE'),
    );
    await assert.rejects(
      files.readText(workspaceId, 'escape/secret.txt'),
      hasCode('SYMLINK_ESCAPE'),
    );
    await assert.rejects(
      files.createText(workspaceId, 'escape/new.txt', 'blocked'),
      hasCode('SYMLINK_ESCAPE'),
    );
  });
});

test('batch helper enforces the hard item maximum', async () => {
  await withFixture(async ({ files }) => {
    assert.deepEqual(
      await files.batch([1, 2, 3], async (value) => value * 2),
      [2, 4, 6],
    );
    await assert.rejects(
      files.batch(
        Array.from(
          { length: FILE_LIMITS.hardBatchItems + 1 },
          (_, index) => index,
        ),
        async (value) => value,
      ),
      hasCode('SIZE_LIMIT_EXCEEDED'),
    );
  });
});
