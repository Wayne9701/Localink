import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ReleaseError,
  ReleaseManager,
  buildReleaseArtifact,
  validateReleaseArtifact,
  type ReleaseManifest,
} from '../src/index.js';

const COMMIT_A = 'a'.repeat(40);

async function withFixture(
  worker: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-release-test-'));
  try {
    await worker(root);
  } finally {
    await makeWritable(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function makeWritable(current: string): Promise<void> {
  const currentStatus = await lstat(current);
  if (currentStatus.isSymbolicLink()) return;
  if (currentStatus.isDirectory()) {
    await chmod(current, 0o700);
    for (const name of await readdir(current)) {
      await makeWritable(path.join(current, name));
    }
  } else if (currentStatus.isFile()) await chmod(current, 0o600);
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fixtureArtifact(
  root: string,
  releaseId: string,
  marker: string,
): Promise<string> {
  const artifact = path.join(root, `artifact-${releaseId}`);
  const entry = path.join(
    artifact,
    'payload',
    'node_modules',
    '@localink',
    'cli',
    'dist',
    'src',
    'cli.js',
  );
  const markerPath = path.join(artifact, 'payload', 'release.txt');
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, '#!/usr/bin/env node\n', { mode: 0o555 });
  await writeFile(markerPath, `${marker}\n`, { mode: 0o444 });
  const files = [];
  for (const [absolute, relative, mode] of [
    [entry, 'payload/node_modules/@localink/cli/dist/src/cli.js', 0o555],
    [markerPath, 'payload/release.txt', 0o444],
  ] as const) {
    const contents = await readFile(absolute);
    files.push({
      path: relative,
      sha256: digest(contents),
      size: contents.length,
      mode,
    });
  }
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    product: 'localink',
    version: '0.1.0',
    releaseId,
    sourceCommit: COMMIT_A,
    builtAt: '2026-09-22T00:00:00.000Z',
    platform: process.platform,
    arch: process.arch,
    requiredNodeMajor: 22,
    dependencyMode: 'packaged-production',
    requiredTunnelClient: '0.0.14',
    entrypoint: 'payload/node_modules/@localink/cli/dist/src/cli.js',
    files,
  };
  await writeFile(
    path.join(artifact, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return artifact;
}

test('builder creates a complete production payload without compiler or dev dependencies', async () => {
  await withFixture(async (root) => {
    const sourceRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    const artifact = path.join(root, 'artifact');
    const manifest = await buildReleaseArtifact({
      sourceRoot,
      artifactRoot: artifact,
      releaseId: 'm6-test-a',
      sourceCommit: COMMIT_A,
      version: '0.1.0',
      builtAt: '2026-09-22T00:00:00.000Z',
    });
    assert.equal(manifest.product, 'localink');
    assert.equal(manifest.dependencyMode, 'packaged-production');
    assert.ok(manifest.files.length > 20);
    await assert.rejects(
      lstat(path.join(artifact, 'payload', 'node_modules', 'typescript')),
      /ENOENT/u,
    );
    assert.equal(
      (await validateReleaseArtifact(artifact)).releaseId,
      'm6-test-a',
    );
    const entrypoint = path.join(
      artifact,
      'payload',
      'node_modules',
      '@localink',
      'cli',
      'dist',
      'src',
      'cli.js',
    );
    const packaged = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        execFile(
          process.execPath,
          [entrypoint, 'core', 'self-test', '--json'],
          {
            cwd: path.join(artifact, 'payload'),
            env: {
              PATH: '/usr/bin:/bin',
              LANG: 'C',
              LC_ALL: 'C',
              LOCALINK_STATE_ROOT: path.join(root, 'packaged-state'),
              LOCALINK_INSTALL_ROOT: artifact,
            },
            timeout: 15_000,
          },
          (error, stdout, stderr) => {
            if (error === null) resolve({ stdout, stderr });
            else reject(error);
          },
        );
      },
    );
    assert.equal((JSON.parse(packaged.stdout) as { ok: boolean }).ok, true);
    assert.equal(packaged.stderr, '');
  });
});

test('manifest integrity, unlisted files, traversal, and symlinks fail closed', async () => {
  await withFixture(async (root) => {
    const artifact = await fixtureArtifact(root, 'release-a', 'A');
    assert.equal(
      (await validateReleaseArtifact(artifact)).releaseId,
      'release-a',
    );
    await chmod(path.join(artifact, 'payload', 'release.txt'), 0o644);
    await writeFile(
      path.join(artifact, 'payload', 'release.txt'),
      'tampered\n',
    );
    await assert.rejects(
      validateReleaseArtifact(artifact),
      (error) =>
        error instanceof ReleaseError &&
        error.code === 'RELEASE_INTEGRITY_MISMATCH',
    );

    const extra = await fixtureArtifact(root, 'release-extra', 'extra');
    await writeFile(path.join(extra, 'payload', 'unlisted.txt'), 'no\n');
    await assert.rejects(
      validateReleaseArtifact(extra),
      (error) =>
        error instanceof ReleaseError &&
        error.code === 'RELEASE_ARTIFACT_INVALID',
    );

    const traversal = await fixtureArtifact(root, 'release-traversal', 'T');
    const manifestPath = path.join(traversal, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ path: string }>;
    };
    manifest.files[0]!.path = '../escape';
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      validateReleaseArtifact(traversal),
      (error) =>
        error instanceof ReleaseError && error.code === 'RELEASE_PATH_UNSAFE',
    );

    const linked = await fixtureArtifact(root, 'release-linked', 'L');
    const target = path.join(linked, 'payload', 'release.txt');
    await rm(target);
    await symlink('/tmp', target);
    await assert.rejects(
      validateReleaseArtifact(linked),
      (error) => error instanceof ReleaseError,
    );
  });
});

test('install A, update A to B, and offline rollback preserve mutable data and immutable releases', async () => {
  await withFixture(async (root) => {
    const artifactA = await fixtureArtifact(root, 'release-a', 'A');
    const artifactB = await fixtureArtifact(root, 'release-b', 'B');
    const installRoot = path.join(root, 'home', '.localink');
    for (const [name, value] of [
      ['state/state.json', 'state'],
      ['config/config.json', 'config'],
      ['secrets/auth', 'secret-metadata-fixture'],
    ] as const) {
      const destination = path.join(installRoot, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, value);
    }
    const activated: string[] = [];
    const manager = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
      hooks: {
        activate: async (_releasePath, manifest) => {
          activated.push(manifest.releaseId);
        },
      },
    });
    assert.equal((await manager.install(artifactA)).status, 'activated');
    assert.deepEqual(await manager.status(), {
      current: 'release-a',
      releases: ['release-a'],
    });
    assert.equal((await manager.install(artifactB)).status, 'activated');
    assert.deepEqual(await manager.status(), {
      current: 'release-b',
      previous: 'release-a',
      releases: ['release-a', 'release-b'],
    });
    await rm(artifactA, { recursive: true });
    await rm(artifactB, { recursive: true });
    const rolledBack = await manager.rollback();
    assert.equal(rolledBack.status, 'rolled_back');
    assert.equal(rolledBack.networkRequiredForRollback, false);
    assert.deepEqual(await manager.status(), {
      current: 'release-a',
      previous: 'release-b',
      releases: ['release-a', 'release-b'],
    });
    assert.deepEqual(activated, ['release-a', 'release-b', 'release-a']);
    assert.equal(
      await readFile(path.join(installRoot, 'state', 'state.json'), 'utf8'),
      'state',
    );
    assert.equal(
      await readFile(path.join(installRoot, 'config', 'config.json'), 'utf8'),
      'config',
    );
    assert.equal(
      await readFile(path.join(installRoot, 'secrets', 'auth'), 'utf8'),
      'secret-metadata-fixture',
    );
    assert.equal(
      (await stat(path.join(installRoot, 'app', 'releases', 'release-a')))
        .mode & 0o777,
      0o555,
    );
    assert.equal(
      await readlink(path.join(installRoot, 'app', 'current')),
      'releases/release-a',
    );
    const launcher = await readFile(
      path.join(installRoot, 'bin', 'localink'),
      'utf8',
    );
    assert.match(launcher, /LOCALINK_INSTALL_ROOT/u);
    const developmentRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    assert.equal(launcher.includes(developmentRoot), false);
  });
});

test('failures before and after switch are bounded and restore the prior release', async () => {
  await withFixture(async (root) => {
    const artifactA = await fixtureArtifact(root, 'release-a', 'A');
    const artifactB = await fixtureArtifact(root, 'release-b', 'B');
    const installRoot = path.join(root, '.localink');
    const managerA = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
    });
    await managerA.install(artifactA);
    const beforeFailure = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
      hooks: {
        beforeSwitch: async () => Promise.reject(new Error('synthetic')),
      },
    });
    const before = await beforeFailure.install(artifactB);
    assert.equal(before.status, 'failed_before_switch');
    assert.equal((await beforeFailure.status()).current, 'release-a');

    const activations: string[] = [];
    const afterFailure = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
      hooks: {
        activate: async (_releasePath, manifest) => {
          activations.push(manifest.releaseId);
          if (manifest.releaseId === 'release-b') {
            throw Object.assign(new Error('synthetic'), {
              code: 'CONTROL_PLANE_POLL_TIMEOUT',
            });
          }
        },
      },
    });
    const after = await afterFailure.install(artifactB);
    assert.equal(after.status, 'failed_rolled_back');
    assert.equal(after.failureDetailCode, 'CONTROL_PLANE_POLL_TIMEOUT');
    assert.deepEqual(activations, ['release-b', 'release-a']);
    assert.equal((await afterFailure.status()).current, 'release-a');
  });
});

test('failed activation restores the exact prior pointers and invokes the prior-service recovery hook', async () => {
  await withFixture(async (root) => {
    const artifactA = await fixtureArtifact(root, 'release-a', 'A');
    const artifactB = await fixtureArtifact(root, 'release-b', 'B');
    const installRoot = path.join(root, '.localink');
    await new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
    }).install(artifactA);

    const events: string[] = [];
    const manager = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
      hooks: {
        activate: async (_releasePath, manifest) => {
          events.push(`activate:${manifest.releaseId}`);
          if (manifest.releaseId === 'release-b') {
            throw Object.assign(new Error('synthetic activation failure'), {
              code: 'LOCAL_MCP_FAILED',
            });
          }
        },
        restorePrior: async ({ currentReleaseId, previousReleaseId }) => {
          events.push(`restore:${currentReleaseId}:${previousReleaseId}`);
        },
      },
    });

    const result = await manager.install(artifactB);
    assert.equal(result.status, 'failed_rolled_back');
    assert.equal(result.servicesVerified, true);
    assert.deepEqual(events, [
      'activate:release-b',
      'restore:release-a:undefined',
    ]);
    assert.deepEqual(await manager.status(), {
      current: 'release-a',
      releases: ['release-a', 'release-b'],
    });
  });
});

test('an activation cannot report success when its lifecycle hook changes current pointer', async () => {
  await withFixture(async (root) => {
    const artifactA = await fixtureArtifact(root, 'release-a', 'A');
    const artifactB = await fixtureArtifact(root, 'release-b', 'B');
    const installRoot = path.join(root, '.localink');
    await new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
    }).install(artifactA);

    let restores = 0;
    const manager = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
      hooks: {
        activate: async (_releasePath, manifest) => {
          if (manifest.releaseId !== 'release-b') return;
          const current = path.join(installRoot, 'app', 'current');
          await rm(current);
          await symlink('releases/release-a', current);
        },
        restorePrior: async () => {
          restores += 1;
        },
      },
    });

    const result = await manager.install(artifactB);
    assert.equal(result.status, 'failed_rolled_back');
    assert.equal(result.failureDetailCode, 'RELEASE_POINTER_STATE_MISMATCH');
    assert.equal(restores, 1);
    assert.deepEqual(await manager.status(), {
      current: 'release-a',
      releases: ['release-a', 'release-b'],
    });
  });
});

test('failed first activation restores the prior live arrangement without a broken launcher', async () => {
  await withFixture(async (root) => {
    const artifact = await fixtureArtifact(root, 'release-a', 'A');
    const installRoot = path.join(root, '.localink');
    let restored = 0;
    const manager = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
      hooks: {
        activate: async () => Promise.reject(new Error('synthetic')),
        restorePrior: async () => {
          restored += 1;
        },
      },
    });
    const result = await manager.install(artifact);
    assert.equal(result.status, 'failed_rolled_back');
    assert.equal(restored, 1);
    assert.equal((await manager.status()).current, undefined);
    await assert.rejects(
      lstat(path.join(installRoot, 'bin', 'localink')),
      /ENOENT/u,
    );
  });
});

test('release receipts preserve launchd transition codes on activation and automatic restore failure', async () => {
  await withFixture(async (root) => {
    const artifact = await fixtureArtifact(root, 'release-a', 'A');
    const launchdCodes = [
      'SERVICE_PREFLIGHT_FAILED',
      'LAUNCHCTL_BOOTOUT_FAILED',
      'LAUNCHCTL_UNLOAD_TIMEOUT',
      'LAUNCHCTL_BOOTSTRAP_FAILED',
      'LAUNCHCTL_REGISTRATION_TIMEOUT',
    ] as const;
    for (const code of launchdCodes) {
      const manager = new ReleaseManager({
        root: path.join(root, code, '.localink'),
        allowFixtureRoot: true,
        hooks: {
          activate: async () => {
            throw Object.assign(
              new Error('synthetic private launchctl output'),
              {
                code,
              },
            );
          },
          restorePrior: async () => undefined,
        },
      });
      const result = await manager.install(artifact);
      assert.equal(result.status, 'failed_rolled_back');
      assert.equal(result.failureDetailCode, code);
      assert.equal(JSON.stringify(result).includes('synthetic private'), false);
    }

    let safeStops = 0;
    const failingRestore = new ReleaseManager({
      root: path.join(root, 'failed-restore', '.localink'),
      allowFixtureRoot: true,
      hooks: {
        activate: async () => {
          throw Object.assign(new Error('synthetic private activation'), {
            code: 'LAUNCHCTL_BOOTSTRAP_FAILED',
          });
        },
        restorePrior: async () => {
          throw Object.assign(new Error('synthetic private restore'), {
            code: 'LAUNCHCTL_UNLOAD_TIMEOUT',
          });
        },
        safeStop: async () => {
          safeStops += 1;
        },
      },
    });
    const result = await failingRestore.install(artifact);
    assert.equal(result.status, 'failed_safe_stop');
    assert.equal(result.failureDetailCode, 'LAUNCHCTL_BOOTSTRAP_FAILED');
    assert.equal(result.rollbackFailureDetailCode, 'LAUNCHCTL_UNLOAD_TIMEOUT');
    assert.equal(safeStops, 1);
    assert.equal(JSON.stringify(result).includes('synthetic private'), false);

    const unavailableSafeStop = new ReleaseManager({
      root: path.join(root, 'unavailable-safe-stop', '.localink'),
      allowFixtureRoot: true,
      hooks: {
        activate: async () => {
          throw Object.assign(new Error('synthetic activation'), {
            code: 'LAUNCHCTL_BOOTSTRAP_FAILED',
          });
        },
        restorePrior: async () => {
          throw Object.assign(new Error('synthetic restore'), {
            code: 'LAUNCHCTL_UNLOAD_TIMEOUT',
          });
        },
      },
    });
    const unavailableResult = await unavailableSafeStop.install(artifact);
    assert.equal(unavailableResult.status, 'failed_safe_stop');
    assert.equal(
      unavailableResult.safeStopFailureDetailCode,
      'SAFE_STOP_UNAVAILABLE',
    );
  });
});

test('rollback failure restores pointers, attempts current recovery once, and safe-stops', async () => {
  await withFixture(async (root) => {
    const artifactA = await fixtureArtifact(root, 'release-a', 'A');
    const artifactB = await fixtureArtifact(root, 'release-b', 'B');
    const installRoot = path.join(root, '.localink');
    const setup = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
    });
    await setup.install(artifactA);
    await setup.install(artifactB);
    let activations = 0;
    let safeStops = 0;
    const failing = new ReleaseManager({
      root: installRoot,
      allowFixtureRoot: true,
      hooks: {
        activate: async () => {
          activations += 1;
          throw new Error('synthetic');
        },
        safeStop: async () => {
          safeStops += 1;
        },
      },
    });
    const result = await failing.rollback();
    assert.equal(result.status, 'failed_safe_stop');
    assert.equal(activations, 2);
    assert.equal(safeStops, 1);
    assert.deepEqual(await failing.status(), {
      current: 'release-b',
      previous: 'release-a',
      releases: ['release-a', 'release-b'],
    });
  });
});

test('production isolation guard rejects non-Localink production roots', async () => {
  await withFixture(async (root) => {
    const manager = new ReleaseManager({ root });
    await assert.rejects(
      manager.status(),
      (error) =>
        error instanceof ReleaseError && error.code === 'RELEASE_PATH_UNSAFE',
    );
  });
});
