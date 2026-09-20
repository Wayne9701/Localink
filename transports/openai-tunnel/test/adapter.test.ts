import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InMemorySecretProvider, SecretValue } from '@localink/core';
import {
  TESTED_LOCAL_TUNNEL_CLIENT_VERSION,
  TunnelAdapterError,
  TunnelProfileStore,
  buildDoctorCommand,
  buildQuickstartHelpCommand,
  buildRunCommand,
  buildTunnelStatus,
  buildVersionCommand,
  discoverTunnelClient,
  executeShortLivedCommand,
  parseDoctorOutput,
  resolveTunnelSecretEnvironment,
  validateTunnelProfile,
} from '../src/index.js';

async function withTemporaryDirectory(
  worker: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'localink-tunnel-test-'));
  try {
    await worker(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fakeBinary(directory: string, output: string): Promise<string> {
  const binaryPath = path.join(directory, 'tunnel-client');
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    { mode: 0o700 },
  );
  await chmod(binaryPath, 0o700);
  return binaryPath;
}

function profileInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'localink-test',
    tunnelId: 'tunnel_0123456789abcdef',
    apiKeySecretRef: {
      provider: 'memory',
      namespace: 'openai-tunnel',
      key: 'runtime-api-key',
    },
    localMcpUrl: 'http://127.0.0.1:4318/mcp',
    ...overrides,
  };
}

test('current tunnel-client discovery is live when installed and fail-visible otherwise', async () => {
  const discovered = await discoverTunnelClient();
  if (!discovered.available) {
    assert.deepEqual(discovered.reasonCodes, ['TUNNEL_BINARY_MISSING']);
    assert.equal(discovered.installRequirement.required, true);
    return;
  }
  assert.ok(path.isAbsolute(discovered.binaryPath ?? ''));
  assert.match(discovered.version ?? '', /^\d+\.\d+\.\d+/u);
  assert.notEqual(discovered.compatibility, 'unsupported');
  const help = await executeShortLivedCommand(
    buildQuickstartHelpCommand(discovered.binaryPath ?? ''),
  );
  assert.match(help.stdout, /quickstart/iu);
});

test('current tunnel-client accepts the generated profile schema when installed', async () => {
  const discovered = await discoverTunnelClient();
  if (!discovered.available || discovered.binaryPath === undefined) return;
  await withTemporaryDirectory(async (directory) => {
    const sourceStore = new TunnelProfileStore(path.join(directory, 'source'));
    const profile = await sourceStore.write(profileInput());
    const targetDirectory = path.join(directory, 'validated-profiles');
    const result = await executeShortLivedCommand({
      command: discovered.binaryPath ?? '',
      args: [
        'profiles',
        'add',
        'localink-validation',
        '--from-file',
        profile.profilePath,
        '--profile-dir',
        targetDirectory,
      ],
    });
    assert.match(result.stdout, /localink-validation/u);
    assert.match(
      await readFile(
        path.join(targetDirectory, 'localink-validation.yaml'),
        'utf8',
      ),
      /env:CONTROL_PLANE_API_KEY/u,
    );
  });
});

test('binary discovery reports missing and malformed versions without installing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const missing = await discoverTunnelClient({
      explicitPath: path.join(directory, 'missing'),
    });
    assert.equal(missing.available, false);
    assert.equal(missing.installRequirement.automaticInstallSupported, false);

    const malformedPath = await fakeBinary(directory, 'future build\n');
    const malformed = await discoverTunnelClient({
      explicitPath: malformedPath,
    });
    assert.equal(malformed.available, true);
    assert.equal(malformed.compatibility, 'unsupported');
    assert.deepEqual(malformed.reasonCodes, ['TUNNEL_VERSION_MALFORMED']);
  });
});

test('tested version is recorded as evidence rather than a permanent install pin', async () => {
  await withTemporaryDirectory(async (directory) => {
    const binaryPath = await fakeBinary(
      directory,
      `${TESTED_LOCAL_TUNNEL_CLIENT_VERSION} (git sha: fixture)\n`,
    );
    const result = await discoverTunnelClient({ explicitPath: binaryPath });
    assert.equal(result.version, TESTED_LOCAL_TUNNEL_CLIENT_VERSION);
    assert.equal(result.compatibility, 'tested');
    assert.equal(result.installRequirement.required, false);

    const futurePath = await fakeBinary(directory, '0.0.12+unvalidated\n');
    const future = await discoverTunnelClient({ explicitPath: futurePath });
    assert.equal(future.compatibility, 'unsupported');
    assert.equal(future.installRequirement.required, true);
  });
});

test('command builders preserve exact argv and never construct a shell command', () => {
  const binaryPath = path.resolve('/opt/localink tools/tunnel-client');
  assert.deepEqual(buildVersionCommand(binaryPath), {
    command: binaryPath,
    args: ['--version'],
  });
  assert.deepEqual(buildQuickstartHelpCommand(binaryPath), {
    command: binaryPath,
    args: ['help', 'quickstart'],
  });
  assert.deepEqual(buildDoctorCommand(binaryPath, 'localink-test'), {
    command: binaryPath,
    args: ['doctor', '--profile', 'localink-test', '--explain'],
  });
  assert.deepEqual(buildRunCommand(binaryPath, 'localink-test'), {
    command: binaryPath,
    args: ['run', '--profile', 'localink-test'],
  });
  assert.deepEqual(
    buildDoctorCommand(binaryPath, 'localink-test', {
      profileDirectory: path.resolve('/tmp/profile dir'),
      json: true,
    }),
    {
      command: binaryPath,
      args: ['doctor', '--profile', 'localink-test', '--explain', '--json'],
      environmentOverrides: {
        TUNNEL_CLIENT_PROFILE_DIR: path.resolve('/tmp/profile dir'),
      },
    },
  );
  assert.throws(
    () => buildRunCommand(binaryPath, 'safe; touch injected'),
    (error) =>
      error instanceof TunnelAdapterError && error.code === 'PROFILE_INVALID',
  );
});

test('profile writer creates and atomically replaces loopback-only YAML', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new TunnelProfileStore(directory);
    const first = await store.write(profileInput());
    const source = await readFile(first.profilePath, 'utf8');
    assert.match(source, /base_url: "https:\/\/api\.openai\.com"/u);
    assert.match(source, /api_key: "env:CONTROL_PLANE_API_KEY"/u);
    assert.match(source, /url: "http:\/\/127\.0\.0\.1:4318\/mcp"/u);
    assert.doesNotMatch(source, /synthetic-secret-value/u);
    assert.doesNotMatch(source, /runtime-api-key|openai-tunnel|memory/u);
    assert.equal(
      JSON.stringify(first).includes('synthetic-secret-value'),
      false,
    );
    assert.equal((await stat(first.profilePath)).mode & 0o777, 0o600);
    assert.equal(first.replaced, false);

    const second = await store.write(
      profileInput({ healthListenAddress: 'localhost:0' }),
      { expectedSha256: first.sha256 },
    );
    assert.equal(second.replaced, true);
    assert.match(await readFile(second.profilePath, 'utf8'), /localhost:0/u);
    assert.deepEqual(
      (await readdir(second.profileDirectory)).filter((name) =>
        name.endsWith('.tmp'),
      ),
      [],
    );
    await assert.rejects(
      store.write(profileInput(), { expectedSha256: first.sha256 }),
      (error) =>
        error instanceof TunnelAdapterError && error.code === 'PROFILE_STALE',
    );
  });
});

test('profile validation allows explicit loopback and rejects unsafe targets', () => {
  assert.equal(
    validateTunnelProfile(
      profileInput({ localMcpUrl: 'http://localhost:3000/mcp' }),
    ).localMcpUrl,
    'http://localhost:3000/mcp',
  );
  for (const localMcpUrl of [
    'http://0.0.0.0:4318/mcp',
    'https://127.0.0.1:4318/mcp',
    'http://example.com:4318/mcp',
    'http://127.0.0.1:4318/other',
    'not a URL',
  ]) {
    assert.throws(
      () => validateTunnelProfile(profileInput({ localMcpUrl })),
      (error) =>
        error instanceof TunnelAdapterError && error.code === 'PROFILE_INVALID',
    );
  }
  for (const healthListenAddress of ['0.0.0.0:8080', ':8080', 'host:8080']) {
    assert.throws(() =>
      validateTunnelProfile(profileInput({ healthListenAddress })),
    );
  }
});

test('secret resolution is provider-bound and redacted outside explicit spawn use', async () => {
  const provider = new InMemorySecretProvider('memory');
  const ref = {
    provider: 'memory',
    namespace: 'openai-tunnel',
    key: 'runtime-api-key',
  };
  const syntheticSecret = 'synthetic-secret-value';
  await provider.set(ref, syntheticSecret);
  const environment = await resolveTunnelSecretEnvironment(provider, ref);
  assert.equal(JSON.stringify(environment).includes(syntheticSecret), false);
  assert.equal(String(environment), '[REDACTED]');
  assert.equal(
    environment.forSpawn({ FIXTURE: 'true' }).CONTROL_PLANE_API_KEY,
    syntheticSecret,
  );
  assert.equal(
    JSON.stringify(new SecretValue(syntheticSecret)),
    '"[REDACTED]"',
  );
  await assert.rejects(
    resolveTunnelSecretEnvironment(provider, { ...ref, key: 'missing' }),
    (error) =>
      error instanceof TunnelAdapterError &&
      error.code === 'SECRET_UNAVAILABLE' &&
      !error.message.includes(syntheticSecret),
  );
});

test('doctor JSON distinguishes ready, auth failure, and local target failure', () => {
  const ready = parseDoctorOutput(
    JSON.stringify({
      profile: { valid: true, tunnel_id_present: true },
      local_mcp: { configured: true, reachable: true },
      control_plane: { auth: 'ready' },
      tunnel: { connected: true, ready: true },
      reason_codes: [],
      future_field: { ignored: true },
    }),
  );
  assert.equal(ready.tunnelReady, 'ready');
  assert.equal(ready.localMcpReachable, 'ready');

  const authFailure = parseDoctorOutput(
    JSON.stringify({
      checks: [
        { id: 'profile_valid', status: 'pass' },
        { id: 'control_plane_auth', status: 'failed' },
      ],
      reason_codes: ['CONTROL_PLANE_AUTH_FAILED'],
    }),
  );
  assert.equal(authFailure.profileValid, 'ready');
  assert.equal(authFailure.controlPlaneAuth, 'failed');
  assert.equal(authFailure.tunnelReady, 'unknown');

  const localFailure = parseDoctorOutput(
    JSON.stringify({
      profile: { valid: true },
      local_mcp: { configured: true, reachable: false },
      tunnel: { connected: 'unknown', ready: 'unknown' },
      reason_codes: ['LOCAL_MCP_UNREACHABLE'],
    }),
  );
  assert.equal(localFailure.localMcpConfigured, 'ready');
  assert.equal(localFailure.localMcpReachable, 'failed');
  assert.equal(localFailure.tunnelConnected, 'unknown');
});

test('doctor parsing is conservative for malformed or unrecognized output', () => {
  for (const output of ['{', '{}', 'everything looks fine']) {
    assert.throws(
      () => parseDoctorOutput(output),
      (error) =>
        error instanceof TunnelAdapterError &&
        error.code === 'DOCTOR_OUTPUT_MALFORMED',
    );
  }
  const text = parseDoctorOutput(
    'PROFILE_VALID=ready\nCONTROL_PLANE_AUTH=failed\nREASON_CODE=AUTH_FAILED\n',
  );
  assert.equal(text.profileValid, 'ready');
  assert.equal(text.controlPlaneAuth, 'failed');
});

test('status composition does not infer tunnel readiness from another layer', () => {
  const status = buildTunnelStatus(
    {
      available: true,
      binaryPath: '/fixture/tunnel-client',
      version: TESTED_LOCAL_TUNNEL_CLIENT_VERSION,
      compatibility: 'tested',
      reasonCodes: ['TUNNEL_BINARY_PRESENT'],
      installRequirement: {
        required: false,
        reasonCode: 'TUNNEL_BINARY_PRESENT',
        automaticInstallSupported: false,
      },
    },
    {
      profileValid: 'ready',
      tunnelIdPresent: 'ready',
      localMcpConfigured: 'ready',
      localMcpReachable: 'ready',
      controlPlaneAuth: 'failed',
      tunnelConnected: 'unknown',
      tunnelReady: 'unknown',
      reasonCodes: ['CONTROL_PLANE_AUTH_FAILED'],
    },
    '2026-09-20T00:00:00.000Z',
  );
  assert.equal(status.localMcpTarget.reachable, 'ready');
  assert.equal(status.controlPlaneAuth, 'failed');
  assert.equal(status.tunnel.connected, 'unknown');
  assert.equal(status.tunnel.ready, 'unknown');
  assert.equal(status.checkedAt, '2026-09-20T00:00:00.000Z');
});
