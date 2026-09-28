import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CAPABILITY_FEATURE_OVERRIDES,
  projectWorkspaceDevCapabilities,
} from '../src/capability-profile.js';

test('workspace-dev-v1 enumerates names only and disables every ambient MCP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-profile-'));
  const executable = path.join(root, 'fake-codex');
  const secret = 'MUST_NOT_SURVIVE_04B';
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' 'Name Command Args Env Cwd Status Auth'
printf '%s\\n' 'engineering-bridge /bin/node --token ${secret} SECRET=${secret} - enabled Unsupported'
printf '%s\\n' 'bigquery /bin/toolbox --secret ${secret} - - enabled Unsupported'
printf '\\n'
printf '%s\\n' 'Name Url Bearer Status Auth'
printf '%s\\n' 'singular https://example.invalid/${secret} - enabled Unknown'
`,
    { mode: 0o700 },
  );
  try {
    const projection = await projectWorkspaceDevCapabilities(executable);
    assert.deepEqual(projection.ambientServerNames, [
      'bigquery',
      'engineering-bridge',
      'singular',
    ]);
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes(secret), false);
    for (const feature of CAPABILITY_FEATURE_OVERRIDES) {
      assert.ok(projection.launchArgs.includes(feature));
    }
    for (const name of projection.ambientServerNames) {
      assert.ok(
        projection.launchArgs.includes(`mcp_servers.${name}.enabled=false`),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability projection fails closed when official enumeration is unavailable', async () => {
  await assert.rejects(
    projectWorkspaceDevCapabilities('/definitely/missing/codex'),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE',
  );
});
