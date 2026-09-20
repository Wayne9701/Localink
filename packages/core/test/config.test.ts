import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { LocalinkError } from '@localink/sdk';
import { ConfigStore, createStatePaths } from '../src/index.js';
import { withFixture } from './helpers.js';

interface ExampleConfig {
  version: number;
  label: string;
}

function validate(value: unknown): ExampleConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    !('label' in value) ||
    typeof value.version !== 'number' ||
    typeof value.label !== 'string' ||
    value.version < 1
  ) {
    throw new Error('invalid example config');
  }
  return { version: value.version, label: value.label };
}

test('config uses an injected root and atomically replaces valid values', async () => {
  await withFixture(async (fixture) => {
    const paths = createStatePaths(fixture.stateRoot);
    assert.equal(paths.root, fixture.stateRoot);
    const store = new ConfigStore(paths, 'example', validate);
    assert.equal(await store.read(), undefined);
    await store.write({ version: 1, label: 'first' });
    await store.write({ version: 2, label: 'second' });
    assert.deepEqual(await store.read(), { version: 2, label: 'second' });
  });
});

test('validation failure does not corrupt previous config', async () => {
  await withFixture(async (fixture) => {
    const store = new ConfigStore(
      createStatePaths(fixture.stateRoot),
      'example',
      validate,
    );
    await store.write({ version: 1, label: 'valid' });
    await assert.rejects(
      store.write({ version: 0, label: 'invalid' }),
      (error) =>
        error instanceof LocalinkError && error.code === 'CONFIG_INVALID',
    );
    assert.deepEqual(await store.read(), { version: 1, label: 'valid' });
  });
});

test('malformed config and partial temp files are fail-visible', async () => {
  await withFixture(async (fixture) => {
    const paths = createStatePaths(fixture.stateRoot);
    const store = new ConfigStore(paths, 'example', validate);
    await mkdir(paths.config, { recursive: true });
    await writeFile(path.join(paths.config, '.example.json.partial.tmp'), '{');
    await store.write({ version: 1, label: 'valid' });
    assert.deepEqual(await store.read(), { version: 1, label: 'valid' });
    await writeFile(store.path, '{bad json');
    await assert.rejects(
      store.read(),
      (error) =>
        error instanceof LocalinkError && error.code === 'CONFIG_INVALID',
    );
  });
});
