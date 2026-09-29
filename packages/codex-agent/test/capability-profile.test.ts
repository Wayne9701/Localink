import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_PROFILE,
  projectCodexNativeCapabilities,
} from '../src/capability-profile.js';

function isIsolationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE'
  );
}

test('codex-native-v1 inherits native capabilities and disables only the configured direct recursion server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  const invocationLog = path.join(root, 'invocations.log');
  const secret = 'MUST_NOT_SURVIVE_04C5';
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$LOCALINK_INVOCATION_LOG"
if [ "$1" != 'mcp' ] || [ "$2" != 'list' ] || [ "$#" -ne 2 ]; then
  exit 91
fi
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'engineering-bridge /bin/node --token ${secret} SECRET=${secret} - enabled Unsupported'
printf '%s\\n' 'bigquery /bin/toolbox --secret ${secret} - - enabled Unsupported'
printf '%s\\n' 'lark-mcp /bin/lark - - - disabled Unsupported'
printf '\\n'
printf '%s\\n' 'Name Url Bearer Status Auth'
printf '%s\\n' 'singular https://example.invalid/${secret} ${secret} enabled Unknown'
`,
    { mode: 0o700 },
  );
  try {
    const projection = await projectCodexNativeCapabilities(executable, {
      ...process.env,
      LOCALINK_INVOCATION_LOG: invocationLog,
    });
    assert.equal(projection.profile, CAPABILITY_PROFILE);
    assert.deepEqual(projection.configuredServerNames, [
      'bigquery',
      'engineering-bridge',
      'lark-mcp',
      'singular',
    ]);
    assert.deepEqual(projection.deniedServerNames, ['engineering-bridge']);
    assert.deepEqual(projection.launchArgs, [
      '-c',
      'mcp_servers.engineering-bridge.enabled=false',
    ]);
    assert.equal(
      projection.launchArgs.filter(
        (arg) => arg === 'mcp_servers.engineering-bridge.enabled=false',
      ).length,
      1,
    );
    assert.equal(JSON.stringify(projection).includes(secret), false);
    assert.equal(
      projection.launchArgs.some((arg) => arg.startsWith('apps.')),
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
    assert.deepEqual(
      (await readFile(invocationLog, 'utf8')).trim().split('\n'),
      ['mcp list'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('codex-native-v1 emits no overrides when the direct recursion server is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'bigquery /bin/toolbox - - - enabled Unsupported'
printf '%s\\n' 'lark-mcp /bin/lark - - - enabled Unsupported'
`,
    { mode: 0o700 },
  );
  try {
    const projection = await projectCodexNativeCapabilities(executable);
    assert.deepEqual(projection.configuredServerNames, [
      'bigquery',
      'lark-mcp',
    ]);
    assert.deepEqual(projection.deniedServerNames, []);
    assert.deepEqual(projection.launchArgs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability projection fails closed on malformed or oversized MCP enumeration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const malformed = path.join(root, 'malformed-codex');
  const oversizedName = path.join(root, 'oversized-name-codex');
  const oversizedOutput = path.join(root, 'oversized-output-codex');
  await writeFile(
    malformed,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'bad.name /bin/toolbox - - - enabled Unsupported'
`,
    { mode: 0o700 },
  );
  await writeFile(
    oversizedName,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' '${'a'.repeat(129)} /bin/toolbox - - - enabled Unsupported'
`,
    { mode: 0o700 },
  );
  await writeFile(
    oversizedOutput,
    `#!/usr/bin/env node
process.stdout.write('Name Command Args Env Cwd Status Auth\\n');
process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 'x'));
`,
    { mode: 0o700 },
  );
  try {
    for (const candidate of [malformed, oversizedName, oversizedOutput]) {
      await assert.rejects(
        projectCodexNativeCapabilities(candidate),
        isIsolationError,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability projection fails closed when official enumeration is unavailable', async () => {
  await assert.rejects(
    projectCodexNativeCapabilities('/definitely/missing/codex'),
    isIsolationError,
  );
});
