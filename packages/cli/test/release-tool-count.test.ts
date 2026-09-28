import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readReleaseToolCount } from '../src/release-tool-count.js';

async function releaseFixture(names: readonly string[]): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-release-tools-'));
  const moduleDir = path.join(
    root,
    'payload',
    'node_modules',
    '@localink',
    'mcp-server',
    'dist',
    'src',
  );
  await mkdir(moduleDir, { recursive: true });
  await writeFile(
    path.join(moduleDir, 'tool-definitions.js'),
    `export const TOOL_NAMES = ${JSON.stringify(names)};\n`,
  );
  return {
    root,
    cleanup: async () => rm(root, { recursive: true, force: true }),
  };
}

test('release readiness reads each release own public tool count', async () => {
  const oldRelease = await releaseFixture(['a', 'b']);
  const newRelease = await releaseFixture(['a', 'b', 'c']);
  try {
    assert.equal(await readReleaseToolCount(oldRelease.root), 2);
    assert.equal(await readReleaseToolCount(newRelease.root), 3);
  } finally {
    await oldRelease.cleanup();
    await newRelease.cleanup();
  }
});

test('release tool inventory fails closed for missing or duplicate inventory', async () => {
  const missing = await mkdtemp(
    path.join(os.tmpdir(), 'localink-release-tools-'),
  );
  const duplicate = await releaseFixture(['a', 'a']);
  try {
    await assert.rejects(
      readReleaseToolCount(missing),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'LOCAL_MCP_FAILED',
    );
    await assert.rejects(
      readReleaseToolCount(duplicate.root),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'LOCAL_MCP_FAILED',
    );
  } finally {
    await rm(missing, { recursive: true, force: true });
    await duplicate.cleanup();
  }
});
