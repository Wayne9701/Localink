import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist']);

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    results.push({ absolutePath, entry });
    if (entry.isDirectory()) results.push(...(await walk(absolutePath)));
  }
  return results;
}

test('source and config contain no developer-specific absolute path', async () => {
  const forbidden = ['', 'Users', 'wayne'].join('/');
  const readableExtensions = new Set([
    '.ts',
    '.js',
    '.json',
    '.md',
    '.yml',
    '.yaml',
  ]);
  const violations = [];
  for (const item of await walk(repositoryRoot)) {
    if (!item.entry.isFile()) continue;
    if (!readableExtensions.has(path.extname(item.absolutePath))) continue;
    const content = await readFile(item.absolutePath, 'utf8');
    if (content.includes(forbidden)) {
      violations.push(path.relative(repositoryRoot, item.absolutePath));
    }
  }
  assert.deepEqual(violations, []);
});

test('repository contains no credential-like files or obvious private material', async () => {
  const credentialName =
    /(^\.env($|\.)|credential|token|\.p8$|\.pem$|\.key$|backup.?code)/iu;
  const suspiciousContent = [
    'BEGIN ' + 'PRIVATE KEY',
    'refresh' + '_token',
    'client' + '_secret',
  ];
  const nameViolations = [];
  const contentViolations = [];
  for (const item of await walk(repositoryRoot)) {
    if (!item.entry.isFile()) continue;
    const relative = path.relative(repositoryRoot, item.absolutePath);
    if (credentialName.test(path.basename(item.absolutePath))) {
      nameViolations.push(relative);
    }
    if (!/\.(ts|js|json|md|ya?ml)$/iu.test(item.absolutePath)) continue;
    const content = await readFile(item.absolutePath, 'utf8');
    if (suspiciousContent.some((marker) => content.includes(marker))) {
      contentViolations.push(relative);
    }
  }
  assert.deepEqual(nameViolations, []);
  assert.deepEqual(contentViolations, []);
});

test('scripts and imports have no forbidden runtime dependency', async () => {
  const forbiddenRuntime = ['Codexless', 'DevSpace', 'Engineering Bridge'];
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const scriptText = JSON.stringify(packageJson.scripts ?? {});
  assert.equal(
    forbiddenRuntime.some((name) => scriptText.includes(name)),
    false,
  );

  const importViolations = [];
  for (const item of await walk(repositoryRoot)) {
    if (!item.entry.isFile() || path.extname(item.absolutePath) !== '.ts')
      continue;
    const content = await readFile(item.absolutePath, 'utf8');
    const importLines = content
      .split(/\r?\n/u)
      .filter((line) => /^\s*(import|export).*from\s/iu.test(line));
    if (
      importLines.some((line) =>
        forbiddenRuntime.some((name) => line.includes(name)),
      )
    ) {
      importViolations.push(path.relative(repositoryRoot, item.absolutePath));
    }
  }
  assert.deepEqual(importViolations, []);
});

test('repository symlinks do not escape and generated state is absent', async () => {
  const violations = [];
  for (const item of await walk(repositoryRoot)) {
    if (!item.entry.isSymbolicLink()) continue;
    const target = await realpath(item.absolutePath);
    if (
      target !== repositoryRoot &&
      !target.startsWith(`${repositoryRoot}${path.sep}`)
    ) {
      violations.push(path.relative(repositoryRoot, item.absolutePath));
    }
  }
  assert.deepEqual(violations, []);
  await assert.rejects(lstat(path.join(repositoryRoot, '.localink')));
});

test('clean install metadata and deterministic scripts are present', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  const lock = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
  );
  assert.equal(packageJson.packageManager, 'npm@10.9.8');
  assert.equal(lock.lockfileVersion, 3);
  for (const name of [
    'build',
    'typecheck',
    'lint',
    'format:check',
    'test',
    'test:portability',
    'check',
  ]) {
    assert.equal(typeof packageJson.scripts[name], 'string');
  }
});
