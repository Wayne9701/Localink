import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  FilesService,
  WorkspaceRegistry,
  createStatePaths,
} from '@localink/core';

const fixture = await mkdtemp(path.join(tmpdir(), 'localink-files-smoke-'));
try {
  const workspaceRoot = path.join(fixture, 'workspace');
  await mkdir(workspaceRoot);
  const workspaces = new WorkspaceRegistry();
  const workspace = await workspaces.register('files-smoke', workspaceRoot);
  const files = new FilesService(
    workspaces,
    createStatePaths(path.join(fixture, 'state-root')),
  );
  const created = await files.createText(workspace.id, 'smoke.txt', 'before\n');
  const edited = await files.preciseEdit({
    workspaceId: workspace.id,
    relativePath: 'smoke.txt',
    expectedText: 'before',
    replacementText: 'after',
    expectedSha256: created.sha256,
    expectedOccurrences: 1,
  });
  assert.equal(
    (await files.readText(workspace.id, 'smoke.txt')).text,
    'after\n',
  );
  const archived = await files.archive(workspace.id, 'smoke.txt');
  assert.equal(await readFile(archived.archivePath, 'utf8'), 'after\n');
  process.stdout.write(
    `${JSON.stringify({ ok: true, created, edited, archived }, null, 2)}\n`,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
