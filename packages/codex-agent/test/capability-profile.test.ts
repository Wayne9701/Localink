import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_PROFILE,
  projectCodexNativeCapabilities,
} from '../src/capability-profile.js';

test('codex-native-v1 inherits normal Codex capabilities and disables only recursive control planes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  const secret = 'MUST_NOT_SURVIVE_04C';
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'engineering-bridge /bin/node --token ${secret} SECRET=${secret} - enabled Unsupported'
printf '%s\\n' 'bigquery /bin/toolbox --secret ${secret} - - enabled Unsupported'
printf '%s\\n' 'lark-mcp /bin/lark - - - disabled Unsupported'
printf '\\n'
printf '%s\\n' 'Name Url Bearer Status Auth'
printf '%s\\n' 'singular https://example.invalid/${secret} - enabled Unknown'
`,
    { mode: 0o700 },
  );
  try {
    const projection = await projectCodexNativeCapabilities(
      executable,
      undefined,
      async () => [
        {
          id: 'asdk_engineering',
          runtimeName: 'Engineering Bridge',
          enabled: true,
          callable: true,
        },
        {
          id: 'asdk_codexless',
          runtimeName: 'Codexless',
          enabled: true,
          callable: true,
        },
        {
          id: 'asdk_devspace',
          runtimeName: 'DevSpace',
          enabled: true,
          callable: true,
        },
        {
          id: 'asdk_localink',
          runtimeName: 'Localink',
          enabled: true,
          callable: true,
        },
        {
          id: 'connector_github',
          runtimeName: 'GitHub',
          enabled: true,
          callable: true,
        },
      ],
    );
    assert.equal(projection.profile, CAPABILITY_PROFILE);
    assert.deepEqual(projection.configuredServerNames, [
      'bigquery',
      'engineering-bridge',
      'lark-mcp',
      'singular',
    ]);
    assert.deepEqual(projection.deniedServerNames, ['engineering-bridge']);
    assert.deepEqual(projection.deniedAppNames, [
      'Codexless',
      'DevSpace',
      'Engineering Bridge',
      'Localink',
    ]);
    assert.deepEqual(projection.launchArgs, [
      '-c',
      'mcp_servers.engineering-bridge.enabled=false',
      '-c',
      'apps.asdk_codexless.enabled=false',
      '-c',
      'apps.asdk_devspace.enabled=false',
      '-c',
      'apps.asdk_engineering.enabled=false',
      '-c',
      'apps.asdk_localink.enabled=false',
    ]);
    assert.equal(JSON.stringify(projection).includes(secret), false);
    assert.equal(
      projection.launchArgs.some((arg) => arg.startsWith('features.')),
      false,
    );
    assert.equal(
      projection.launchArgs.includes('mcp_servers.bigquery.enabled=false'),
      false,
    );
    assert.equal(
      projection.launchArgs.includes('mcp_servers.lark-mcp.enabled=true'),
      false,
    );
    assert.equal(
      projection.launchArgs.includes('apps.connector_github.enabled=false'),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('codex-native-v1 preserves already-disabled and ordinary apps without incomplete overrides', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'bigquery /bin/toolbox - - - enabled Unsupported'
`,
    { mode: 0o700 },
  );
  try {
    const projection = await projectCodexNativeCapabilities(
      executable,
      undefined,
      async () => [
        {
          id: 'asdk_localink',
          runtimeName: 'Localink',
          enabled: false,
          callable: false,
        },
        {
          id: 'connector_gmail',
          runtimeName: 'Gmail',
          enabled: true,
          callable: true,
        },
      ],
    );
    assert.deepEqual(projection.deniedServerNames, []);
    assert.deepEqual(projection.deniedAppNames, []);
    assert.deepEqual(projection.launchArgs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability projection fails closed when official MCP enumeration is unavailable', async () => {
  await assert.rejects(
    projectCodexNativeCapabilities('/definitely/missing/codex'),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE',
  );
});
