import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { LocalinkError } from '@localink/sdk';
import {
  FilesService,
  createStatePaths,
  type TransferItem,
} from '../src/index.js';
import { withFixture } from './helpers.js';

const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const code = (expected: string) => (error: unknown) =>
  error instanceof LocalinkError && error.code === expected;
const item = (
  sourceWorkspaceId: string,
  destinationWorkspaceId: string,
  sourceRelativePath: string,
  destinationRelativePath: string,
  operation: 'copy' | 'move' = 'copy',
): TransferItem => ({
  operation,
  sourceWorkspaceId,
  sourceRelativePath,
  destinationWorkspaceId,
  destinationRelativePath,
});

test('mkdir creates exactly one directory and rejects existing, missing, file, and escaping parents', async () => {
  await withFixture(async ({ files, workspaceId, workspaceRoot, root }) => {
    const created = await files.mkdir(workspaceId, 'new');
    assert.equal(created.created, true);
    assert.equal(created.relativePath, 'new');
    assert.equal(
      (await stat(path.join(workspaceRoot, 'new'))).isDirectory(),
      true,
    );
    assert.equal(JSON.stringify(created).includes(root), false);
    await assert.rejects(
      files.mkdir(workspaceId, 'new'),
      code('ALREADY_EXISTS'),
    );
    await assert.rejects(
      files.mkdir(workspaceId, 'missing/child'),
      code('NOT_FOUND'),
    );
    await writeFile(path.join(workspaceRoot, 'parent.txt'), 'x');
    await assert.rejects(
      files.mkdir(workspaceId, 'parent.txt/child'),
      code('NOT_FOUND'),
    );
    await assert.rejects(
      files.mkdir(workspaceId, '../outside'),
      code('PATH_OUTSIDE_WORKSPACE'),
    );
    await mkdir(path.join(root, 'outside'));
    await symlink(
      path.join(root, 'outside'),
      path.join(workspaceRoot, 'escape'),
    );
    await assert.rejects(
      files.mkdir(workspaceId, 'escape/child'),
      code('SYMLINK_ESCAPE'),
    );
    await assert.rejects(
      files.mkdir(workspaceId, 'new/../../outside'),
      code('PATH_OUTSIDE_WORKSPACE'),
    );
    await assert.rejects(files.mkdir('unregistered', 'new'), code('NOT_FOUND'));
  });
});

test('verified copy supports same and cross workspace, file only, no overwrite, and cleans verification failure', async () => {
  await withFixture(
    async ({
      files,
      workspaceId,
      workspaceRoot,
      workspaces,
      stateRoot,
      root,
    }) => {
      const secondRoot = path.join(root, 'second');
      await mkdir(secondRoot);
      const second = await workspaces.register('second', secondRoot);
      await writeFile(path.join(workspaceRoot, 'source.txt'), 'payload');
      const same = await files.copy(workspaceId, 'source.txt', 'same.txt');
      assert.equal(same.sha256, digest('payload'));
      const cross = await files.transfer(
        item(workspaceId, second.id, 'source.txt', 'cross.txt'),
      );
      assert.equal(cross.destinationWorkspaceId, second.id);
      assert.equal(
        cross.sha256,
        digest(await readFile(path.join(secondRoot, 'cross.txt'), 'utf8')),
      );
      assert.equal(JSON.stringify(cross).includes(root), false);
      await assert.rejects(
        files.transfer(item(workspaceId, second.id, 'source.txt', 'cross.txt')),
        code('ALREADY_EXISTS'),
      );
      await assert.rejects(
        files.transfer(
          item(workspaceId, second.id, 'missing.txt', 'missing-copy.txt'),
        ),
        code('NOT_FOUND'),
      );
      await mkdir(path.join(workspaceRoot, 'directory'));
      await assert.rejects(
        files.transfer(
          item(workspaceId, second.id, 'directory', 'directory-copy'),
        ),
        code('INVALID_ARGUMENT'),
      );
      await assert.rejects(
        files.transfer(
          item(workspaceId, second.id, '../outside', 'escape.txt'),
        ),
        code('PATH_OUTSIDE_WORKSPACE'),
      );
      await symlink(secondRoot, path.join(workspaceRoot, 'escape'));
      await assert.rejects(
        files.transfer(
          item(workspaceId, second.id, 'escape/cross.txt', 'escape-copy.txt'),
        ),
        code('SYMLINK_ESCAPE'),
      );
      await writeFile(path.join(root, 'outside-copy'), 'outside');
      await symlink(
        path.join(root, 'outside-copy'),
        path.join(workspaceRoot, 'destination-escape'),
      );
      await assert.rejects(
        files.transfer(
          item(workspaceId, workspaceId, 'source.txt', 'destination-escape'),
        ),
        code('SYMLINK_ESCAPE'),
      );
      const faulty = new FilesService(workspaces, createStatePaths(stateRoot), {
        verifyHash: async () => '0'.repeat(64),
      });
      await assert.rejects(
        faulty.transfer(item(workspaceId, second.id, 'source.txt', 'bad.txt')),
        code('IO_ERROR'),
      );
      await assert.rejects(access(path.join(secondRoot, 'bad.txt')));
      assert.equal(
        await readFile(path.join(workspaceRoot, 'source.txt'), 'utf8'),
        'payload',
      );
    },
  );
});

test('guarded replacement enforces text, size, file and hash with atomic receipt', async () => {
  await withFixture(async ({ files, workspaceId, workspaceRoot }) => {
    await writeFile(path.join(workspaceRoot, 'text.txt'), 'before');
    await assert.rejects(
      files.replaceTextAtomic(workspaceId, 'text.txt', 'after', '0'.repeat(64)),
      code('STALE_PRECONDITION'),
    );
    assert.equal(
      await readFile(path.join(workspaceRoot, 'text.txt'), 'utf8'),
      'before',
    );
    const receipt = await files.replaceTextAtomic(
      workspaceId,
      'text.txt',
      'after',
      digest('before'),
    );
    assert.equal(receipt.previousSha256, digest('before'));
    assert.equal(receipt.sha256, digest('after'));
    assert.equal(
      await readFile(path.join(workspaceRoot, 'text.txt'), 'utf8'),
      'after',
    );
    await assert.rejects(
      files.replaceTextAtomic(workspaceId, 'missing.txt', 'x', digest('x')),
      code('NOT_FOUND'),
    );
    await mkdir(path.join(workspaceRoot, 'directory'));
    await assert.rejects(
      files.replaceTextAtomic(workspaceId, 'directory', 'x', digest('x')),
      code('INVALID_ARGUMENT'),
    );
    await writeFile(
      path.join(workspaceRoot, 'binary.bin'),
      Buffer.from([0, 1]),
    );
    await assert.rejects(
      files.replaceTextAtomic(workspaceId, 'binary.bin', 'x', digest('\0\x01')),
      code('BINARY_NOT_SUPPORTED'),
    );
    await assert.rejects(
      files.replaceTextAtomic(
        workspaceId,
        'text.txt',
        'x'.repeat(2 * 1024 * 1024 + 1),
        receipt.sha256,
      ),
      code('SIZE_LIMIT_EXCEEDED'),
    );
  });
});

test('batch preflight prevents mutations on conflicts and exposes runtime partial completion', async () => {
  await withFixture(
    async ({
      files,
      workspaceId,
      workspaceRoot,
      workspaces,
      stateRoot,
      root,
    }) => {
      const secondRoot = path.join(root, 'second');
      await mkdir(secondRoot);
      const second = await workspaces.register('second', secondRoot);
      for (const name of ['one', 'two', 'three'])
        await writeFile(path.join(workspaceRoot, name), name);
      const first = item(workspaceId, second.id, 'one', 'copied');
      const secondItem = item(workspaceId, second.id, 'two', 'moved', 'move');
      await assert.rejects(
        files.batchTransfer([first, first]),
        code('INVALID_ARGUMENT'),
      );
      await assert.rejects(
        files.batchTransfer([
          first,
          item(workspaceId, second.id, 'three', 'copied'),
        ]),
        code('INVALID_ARGUMENT'),
      );
      await assert.rejects(
        files.batchTransfer([
          first,
          item(workspaceId, second.id, 'missing', 'other'),
        ]),
        code('NOT_FOUND'),
      );
      await writeFile(path.join(secondRoot, 'existing'), 'keep');
      await assert.rejects(
        files.batchTransfer([
          first,
          item(workspaceId, second.id, 'three', 'existing'),
        ]),
        code('ALREADY_EXISTS'),
      );
      assert.equal(
        await readFile(path.join(secondRoot, 'existing'), 'utf8'),
        'keep',
      );
      await assert.rejects(access(path.join(secondRoot, 'copied')));
      const complete = await files.batchTransfer([first, secondItem]);
      assert.equal(complete.status, 'completed');
      assert.equal(complete.completed, 2);
      assert.equal(
        await readFile(path.join(secondRoot, 'moved'), 'utf8'),
        'two',
      );
      await assert.rejects(access(path.join(workspaceRoot, 'two')));
      const faulty = new FilesService(workspaces, createStatePaths(stateRoot), {
        verifyHash: async (absolutePath) =>
          absolutePath.endsWith('bad')
            ? '0'.repeat(64)
            : digest(await readFile(absolutePath, 'utf8')),
      });
      const partial = await faulty.batchTransfer([
        item(workspaceId, second.id, 'one', 'good'),
        item(workspaceId, second.id, 'three', 'bad', 'move'),
        item(workspaceId, second.id, 'one', 'never'),
      ]);
      assert.equal(partial.status, 'partial');
      assert.equal(partial.completed, 1);
      assert.deepEqual(
        partial.items.map((entry) => entry.status),
        ['completed', 'failed', 'not_executed'],
      );
      assert.equal(
        await readFile(path.join(secondRoot, 'good'), 'utf8'),
        'one',
      );
      await assert.rejects(access(path.join(secondRoot, 'bad')));
      await assert.rejects(access(path.join(secondRoot, 'never')));
      assert.equal(
        await readFile(path.join(workspaceRoot, 'three'), 'utf8'),
        'three',
      );
      await assert.rejects(
        files.batchTransfer(
          Array.from({ length: 101 }, (_, n) =>
            item(workspaceId, second.id, 'one', String(n)),
          ),
        ),
        code('INVALID_ARGUMENT'),
      );
    },
  );
});

test('cross-device move fallback verifies before unlink and preserves source on failure', async () => {
  await withFixture(
    async ({ workspaceId, workspaceRoot, workspaces, stateRoot, root }) => {
      const secondRoot = path.join(root, 'second');
      await mkdir(secondRoot);
      const second = await workspaces.register('second', secondRoot);
      await writeFile(path.join(workspaceRoot, 'source'), 'payload');
      const exdev = Object.assign(new Error('cross device'), { code: 'EXDEV' });
      const files = new FilesService(workspaces, createStatePaths(stateRoot), {
        linkFile: async () => {
          throw exdev;
        },
      });
      const receipt = await files.transfer(
        item(workspaceId, second.id, 'source', 'destination', 'move'),
      );
      assert.equal(receipt.sha256, digest('payload'));
      await assert.rejects(access(path.join(workspaceRoot, 'source')));
      assert.equal(
        await readFile(path.join(secondRoot, 'destination'), 'utf8'),
        'payload',
      );
      await writeFile(path.join(workspaceRoot, 'fail-source'), 'preserve');
      const faulty = new FilesService(workspaces, createStatePaths(stateRoot), {
        linkFile: async () => {
          throw exdev;
        },
        verifyHash: async () => '0'.repeat(64),
      });
      await assert.rejects(
        faulty.transfer(
          item(
            workspaceId,
            second.id,
            'fail-source',
            'fail-destination',
            'move',
          ),
        ),
        code('IO_ERROR'),
      );
      assert.equal(
        await readFile(path.join(workspaceRoot, 'fail-source'), 'utf8'),
        'preserve',
      );
      await assert.rejects(access(path.join(secondRoot, 'fail-destination')));
    },
  );
});
