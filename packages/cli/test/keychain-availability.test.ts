import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createKeychainAvailabilityProbe } from '../src/keychain-availability.js';

const ref = {
  provider: 'macos-keychain',
  namespace: 'openai-tunnel',
  key: 'runtime-api-key',
} as const;

test('shared tunnel availability probe is metadata-only across doctor, recovery, bootstrap, configure, and status paths', async () => {
  let metadataFindCount = 0;
  let secretReadCount = 0;
  const adapter = {
    async exists(service: string, account: string) {
      metadataFindCount += 1;
      assert.equal(service, 'localink.openai-tunnel');
      assert.equal(account, 'runtime-api-key');
      return true;
    },
    async read() {
      secretReadCount += 1;
      return 'synthetic-secret';
    },
  };
  const probe = createKeychainAvailabilityProbe(adapter);
  const availabilityPaths = [
    'doctor',
    'recovery inspection',
    'service bootstrap prereq',
    'tunnel configure response',
    'tunnel status',
    'repeated doctor',
    'repeated recovery inspection',
  ];
  for (let index = 0; index < availabilityPaths.length; index += 1) {
    assert.equal(await probe.exists(ref), true);
  }
  assert.equal(metadataFindCount, availabilityPaths.length);
  assert.equal(secretReadCount, 0);
});

test('availability probe reports absent metadata without a secret read', async () => {
  let secretReadCount = 0;
  const adapter = {
    async exists() {
      return false;
    },
    async read() {
      secretReadCount += 1;
      return 'synthetic-secret';
    },
  };
  const probe = createKeychainAvailabilityProbe(adapter);
  assert.equal(await probe.exists(ref), false);
  assert.equal(secretReadCount, 0);
});

test('availability probe fails visibly without exposing executor detail', async () => {
  const probe = createKeychainAvailabilityProbe({
    async exists() {
      throw new Error('private Keychain failure detail');
    },
  });
  await assert.rejects(
    probe.exists(ref),
    (error) =>
      error instanceof Error &&
      error.message === 'Keychain availability check failed.' &&
      !error.message.includes('private Keychain failure detail'),
  );
});

test('CLI reserves the secret provider for tunnel-run and never uses it in availability inspection', async () => {
  const cliSource = await readFile(
    fileURLToPath(new URL('../../src/cli.ts', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(cliSource, /keychainProvider\(\)\.get/u);
  assert.doesNotMatch(cliSource, /resolveTunnelSecretEnvironment/u);
  assert.match(
    cliSource,
    /runTunnelWrapper\([\s\S]*?keychainProvider\(\)[\s\S]*?new SystemTunnelChildLauncher\(\)/u,
  );
});
