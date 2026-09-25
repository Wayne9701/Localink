import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tunnelAuthFilePath } from '@localink/openai-tunnel';
import {
  DEFAULT_RECOVERY_POLICY,
  LaunchctlExecutor,
  LocalServiceController,
  MacOSKeychainAdapter,
  SERVICE_LABELS,
  ServiceFoundationError,
  buildBootoutCommand,
  buildBootstrapCommand,
  buildKickstartCommand,
  buildPrintCommand,
  composeServiceTopologyStatus,
  createInstallPlan,
  createInstallationContext,
  createLaunchAgentArtifacts,
  createServiceDefinitions,
  createServiceStatus,
  createTunnelServiceConfig,
  isLocalinkOwnedTunnelClientPath,
  localinkTunnelClientPath,
  createUninstallPlan,
  decideRecovery,
  dispatchServiceEntrypoint,
  executeRecoveryOnce,
  inspectTunnelAuthFile,
  migrateLegacyKeychainTunnelAuth,
  readServiceSnapshot,
  readTunnelServiceConfig,
  renderLaunchAgentPlist,
  runTunnelWrapper,
  serviceSnapshotPath,
  writeServiceSnapshot,
  writeTunnelServiceConfig,
  type FixedCommandExecutor,
  type InstallationContext,
  type RecoveryDecision,
  type RecoveryInput,
  type ServiceStatus,
  type TunnelChildLauncher,
} from '../src/index.js';

async function withTemporaryDirectory(
  worker: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'localink-service-test-'),
  );
  try {
    await worker(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fixtureContext(root: string): InstallationContext {
  const userHome = path.join(root, 'home');
  return createInstallationContext({
    installPrefix: path.join(root, 'install'),
    localinkExecutablePath: path.join(root, 'install', 'bin', 'localink'),
    localinkEntrypointArguments: [],
    runtimePath: path.join(root, 'install', 'runtime'),
    stateRoot: path.join(root, 'state'),
    configRoot: path.join(root, 'state', 'config'),
    logRoot: path.join(root, 'state', 'logs'),
    userHome,
    launchAgentsDirectory: path.join(userHome, 'Library', 'LaunchAgents'),
    uid: 501,
  });
}

function serviceStatus(
  serviceId: 'localink-core' | 'localink-tunnel',
  overrides: Partial<ServiceStatus> = {},
): ServiceStatus {
  const processRunning = overrides.processRunning ?? true;
  return createServiceStatus({
    serviceId,
    installed: true,
    processRunning,
    ...(processRunning
      ? { pid: serviceId === 'localink-core' ? 101 : 202 }
      : {}),
    readiness: 'ready',
    recentRestarts: 0,
    checkedAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  });
}

function recoveryInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    core: serviceStatus('localink-core'),
    localMcpReadiness: 'ready',
    tunnel: serviceStatus('localink-tunnel'),
    tunnelConnected: 'ready',
    tunnelReady: 'ready',
    tunnelAuth: 'ready',
    coreConfig: 'valid',
    tunnelConfig: 'valid',
    tunnelSecret: 'available',
    restartHistory: [],
    now: '2026-09-20T12:00:00.000Z',
    policy: DEFAULT_RECOVERY_POLICY,
    operatorIntent: { kind: 'automatic' },
    ...overrides,
  };
}

function execFileResult(
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], (error, stdout, stderr) => {
      if (error === null) resolve({ stdout, stderr });
      else reject(error);
    });
  });
}

test('three deterministic LaunchAgent definitions use injected paths and isolated logs', async () => {
  await withTemporaryDirectory(async (root) => {
    const context = fixtureContext(root);
    await mkdir(path.dirname(context.localinkExecutablePath), {
      recursive: true,
    });
    await mkdir(context.runtimePath, { recursive: true });
    await writeFile(context.localinkExecutablePath, '#!/bin/sh\n', {
      mode: 0o700,
    });
    const first = createServiceDefinitions(context);
    const second = createServiceDefinitions(context);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.map((item) => item.serviceId),
      ['localink-core', 'localink-tunnel', 'localink-recovery'],
    );
    assert.equal(new Set(first.map((item) => item.Label)).size, 3);
    assert.deepEqual(
      first.map((item) => item.Label),
      Object.values(SERVICE_LABELS),
    );
    assert.equal(new Set(first.map((item) => item.StandardOutPath)).size, 3);
    assert.equal(new Set(first.map((item) => item.StandardErrorPath)).size, 3);
    for (const item of first) {
      assert.equal(item.ProgramArguments[0], context.localinkExecutablePath);
      assert.equal(item.WorkingDirectory, context.runtimePath);
      assert.equal(item.RunAtLoad, true);
      assert.equal(item.KeepAlive, false);
      assert.equal(
        item.EnvironmentVariables.LOCALINK_STATE_ROOT,
        context.stateRoot,
      );
    }
    assert.equal(first[2]?.StartInterval, 60);
    assert.deepEqual(first[0]?.ProgramArguments, [
      context.localinkExecutablePath,
      'service',
      'core-run',
    ]);
    assert.deepEqual(first[1]?.ProgramArguments, [
      context.localinkExecutablePath,
      'service',
      'tunnel-run',
    ]);
    assert.deepEqual(first[2]?.ProgramArguments, [
      context.localinkExecutablePath,
      'service',
      'recovery-run',
      '--once',
    ]);
  });
});

test('rendered artifacts pass plutil lint and contain no credential or developer path', async () => {
  await withTemporaryDirectory(async (root) => {
    const artifacts = createLaunchAgentArtifacts(fixtureContext(root));
    for (const artifact of artifacts) {
      const temporaryPath = path.join(root, `${artifact.label}.plist`);
      await writeFile(temporaryPath, artifact.contents, { mode: 0o600 });
      const lint = await execFileResult('/usr/bin/plutil', [
        '-lint',
        temporaryPath,
      ]);
      assert.match(lint.stdout, /OK/u);
      const source = await readFile(temporaryPath, 'utf8');
      assert.match(source, /<key>ProgramArguments<\/key>\n {2}<array>/u);
      assert.equal(source.includes('CONTROL_PLANE_API_KEY'), false);
      assert.equal(source.includes('runtime-api-key'), false);
      assert.equal(source.includes('.local/bin/tunnel-client'), false);
      assert.equal(source.includes(['', 'Users', 'wayne'].join('/')), false);
      assert.equal((await stat(temporaryPath)).mode & 0o777, 0o600);
    }
  });
});

test('installation context is user-domain only and fully injected', async () => {
  await withTemporaryDirectory(async (root) => {
    const context = fixtureContext(root);
    assert.equal(context.launchdDomain, 'gui/501');
    assert.throws(
      () => createInstallationContext({ ...context, uid: 0 }),
      (error) =>
        error instanceof ServiceFoundationError &&
        error.code === 'INSTALLATION_CONTEXT_INVALID',
    );
    assert.throws(
      () =>
        createInstallationContext({
          ...context,
          launchAgentsDirectory: path.join(root, 'LaunchAgents'),
        }),
      (error) =>
        error instanceof ServiceFoundationError &&
        error.code === 'INSTALLATION_CONTEXT_INVALID',
    );
  });
});

test('plist renderer rejects secret-bearing or non-absolute environment input', async () => {
  await withTemporaryDirectory(async (root) => {
    const definition = createServiceDefinitions(fixtureContext(root))[0];
    assert.ok(definition !== undefined);
    assert.throws(
      () =>
        renderLaunchAgentPlist({
          ...definition,
          EnvironmentVariables: {
            ...definition.EnvironmentVariables,
            CONTROL_PLANE_API_KEY: 'synthetic-service-secret',
          },
        }),
      (error) =>
        error instanceof ServiceFoundationError &&
        error.code === 'PLIST_INVALID',
    );
  });
});

test('launchctl builders return validated argv without executing launchctl', async () => {
  await withTemporaryDirectory(async (root) => {
    const context = fixtureContext(root);
    const artifact = createLaunchAgentArtifacts(context)[0];
    assert.ok(artifact !== undefined);
    assert.deepEqual(buildBootstrapCommand(context, artifact), {
      command: '/bin/launchctl',
      args: ['bootstrap', 'gui/501', artifact.destinationPath],
    });
    assert.deepEqual(buildBootoutCommand(context, artifact.label), {
      command: '/bin/launchctl',
      args: ['bootout', `gui/501/${artifact.label}`],
    });
    assert.deepEqual(buildKickstartCommand(context, artifact.label, true), {
      command: '/bin/launchctl',
      args: ['kickstart', '-k', `gui/501/${artifact.label}`],
    });
    assert.deepEqual(buildPrintCommand(context, artifact.label), {
      command: '/bin/launchctl',
      args: ['print', `gui/501/${artifact.label}`],
    });
    assert.throws(() => buildPrintCommand(context, 'bad;label'));
  });
});

test('install and uninstall plans are pure and preserve user data and secrets', async () => {
  await withTemporaryDirectory(async (root) => {
    const context = fixtureContext(root);
    const install = createInstallPlan(context);
    const uninstall = createUninstallPlan(context);
    assert.equal(install.artifacts.length, 3);
    assert.equal(install.requiresRoot, false);
    assert.equal(uninstall.requiresRoot, false);
    assert.equal(uninstall.preservesUserData, true);
    assert.equal(uninstall.preservesSecrets, true);
    assert.deepEqual(uninstall.preservePaths, [
      context.stateRoot,
      context.configRoot,
      context.logRoot,
    ]);
    await assert.rejects(stat(context.launchAgentsDirectory));
  });
});

test('tunnel wrapper uses fixed argv without reading or injecting a secret', async () => {
  await withTemporaryDirectory(async (root) => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
      shell: false;
    }> = [];
    const launcher: TunnelChildLauncher = {
      async launch(command, args, options) {
        calls.push({ command, args, env: options.env, shell: options.shell });
        return {
          pid: 404,
          async wait() {
            return { exitCode: 0, signal: null };
          },
          signal() {
            return true;
          },
        };
      },
    };
    const receipt = await runTunnelWrapper(
      {
        binaryPath: path.join(root, 'bin', 'tunnel-client'),
        profileName: 'localink',
        profileDirectory: path.join(root, 'profiles'),
        workingDirectory: root,
        baseEnvironment: { LANG: 'C' },
      },
      launcher,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.env.CONTROL_PLANE_API_KEY, undefined);
    assert.equal(calls[0]?.shell, false);
    assert.deepEqual(calls[0]?.args, [
      'run',
      '--profile',
      'localink',
      '--profile-dir',
      path.join(root, 'profiles'),
    ]);
    assert.equal(receipt.secretInjected, false);
    assert.equal(receipt.authSource, 'file-reference');
    assert.deepEqual(receipt.injectedEnvironmentKeys, []);
  });
});

test('tunnel wrapper rejects auth environment injection before launch', async () => {
  await withTemporaryDirectory(async (root) => {
    const launcher: TunnelChildLauncher = {
      async launch() {
        throw new Error('launcher must not be called');
      },
    };
    const input = {
      binaryPath: path.join(root, 'bin', 'tunnel-client'),
      profileName: 'localink',
      profileDirectory: path.join(root, 'profiles'),
      workingDirectory: root,
    };
    await assert.rejects(
      runTunnelWrapper(
        {
          ...input,
          baseEnvironment: { CONTROL_PLANE_API_KEY: 'bypass' },
        },
        launcher,
      ),
      (error) =>
        error instanceof ServiceFoundationError &&
        error.code === 'TUNNEL_LAUNCH_FAILED',
    );
  });
});

test('service topology preserves process and readiness layers without inference', () => {
  const core = serviceStatus('localink-core', {
    processRunning: true,
    readiness: 'ready',
  });
  const tunnel = serviceStatus('localink-tunnel', {
    processRunning: true,
    readiness: 'ready',
  });
  const topology = composeServiceTopologyStatus({
    core,
    localMcpReadiness: 'failed',
    tunnel,
    tunnelConnected: 'unknown',
    tunnelReady: 'failed',
    checkedAt: '2026-09-20T12:00:00.000Z',
  });
  assert.equal(topology.core.processRunning, true);
  assert.equal(topology.localMcpReadiness, 'failed');
  assert.equal(topology.tunnel.processRunning, true);
  assert.equal(topology.tunnelConnected, 'unknown');
  assert.equal(topology.tunnelReady, 'failed');

  const stale = createServiceStatus({
    serviceId: 'localink-core',
    installed: true,
    processRunning: false,
    pid: 999,
    readiness: 'unknown',
    recentRestarts: 0,
    checkedAt: '2026-09-20T12:00:00.000Z',
  });
  assert.ok(stale.reasonCodes.includes('STALE_PID_OBSERVED'));
});

test('healthy services produce one no-action decision', () => {
  const input = recoveryInput();
  const before = structuredClone(input);
  const result = decideRecovery(input);
  assert.deepEqual(result, {
    action: 'no_action',
    reasonCode: 'SERVICES_READY',
    checkedAt: input.now,
    oneShot: true,
  });
  assert.deepEqual(input, before);
});

test('recovery service entrypoint is explicitly one-shot', async () => {
  const calls = { core: 0, tunnel: 0, recovery: 0 };
  const result = await dispatchServiceEntrypoint(
    ['service', 'recovery-run', '--once'],
    {
      async runCore() {
        calls.core += 1;
        return 'core';
      },
      async runTunnel() {
        calls.tunnel += 1;
        return 'tunnel';
      },
      async runRecoveryOnce() {
        calls.recovery += 1;
        return 'recovery';
      },
    },
  );
  assert.equal(result, 'recovery');
  assert.deepEqual(calls, { core: 0, tunnel: 0, recovery: 1 });
  await assert.rejects(
    dispatchServiceEntrypoint(['service', 'recovery-run'], {
      async runCore() {
        return 'core';
      },
      async runTunnel() {
        return 'tunnel';
      },
      async runRecoveryOnce() {
        return 'recovery';
      },
    }),
  );
});

test('dependency-aware recovery prioritizes Core start and readiness', () => {
  const stoppedCore = serviceStatus('localink-core', {
    processRunning: false,
    readiness: 'unknown',
  });
  const start = decideRecovery(
    recoveryInput({
      core: stoppedCore,
      localMcpReadiness: 'failed',
      tunnel: serviceStatus('localink-tunnel', {
        processRunning: false,
        readiness: 'unknown',
      }),
    }),
  );
  assert.equal(start.action, 'start');
  assert.equal(start.serviceId, 'localink-core');

  const notReady = decideRecovery(
    recoveryInput({ localMcpReadiness: 'failed' }),
  );
  assert.equal(notReady.action, 'restart');
  assert.equal(notReady.serviceId, 'localink-core');
  assert.equal(notReady.reasonCode, 'LOCAL_MCP_NOT_READY');
});

test('Tunnel starts only when Core is ready and auth prerequisites are healthy', () => {
  const stoppedTunnel = serviceStatus('localink-tunnel', {
    processRunning: false,
    readiness: 'unknown',
  });
  const start = decideRecovery(recoveryInput({ tunnel: stoppedTunnel }));
  assert.equal(start.action, 'start');
  assert.equal(start.serviceId, 'localink-tunnel');

  const authFailure = decideRecovery(
    recoveryInput({ tunnel: stoppedTunnel, tunnelAuth: 'failed' }),
  );
  assert.equal(authFailure.action, 'manual_intervention');
  assert.equal(authFailure.reasonCode, 'TUNNEL_AUTH_FAILED');

  const missingSecret = decideRecovery(
    recoveryInput({ tunnel: stoppedTunnel, tunnelSecret: 'missing' }),
  );
  assert.equal(missingSecret.action, 'manual_intervention');
  assert.equal(missingSecret.reasonCode, 'TUNNEL_SECRET_MISSING');

  const notActivated = decideRecovery(
    recoveryInput({
      tunnel: serviceStatus('localink-tunnel', {
        installed: false,
        processRunning: false,
        readiness: 'unknown',
      }),
    }),
  );
  assert.equal(notActivated.action, 'no_action');
  assert.equal(notActivated.reasonCode, 'TUNNEL_NOT_ACTIVATED');
  assert.equal(notActivated.serviceId, 'localink-tunnel');
});

test('transient crashes back off and repeated crashes enter cooldown/manual state', () => {
  const stoppedCore = serviceStatus('localink-core', {
    processRunning: false,
    readiness: 'failed',
    lastExit: { at: '2026-09-20T11:59:59.000Z', code: 1 },
  });
  const transient = decideRecovery(
    recoveryInput({
      core: stoppedCore,
      localMcpReadiness: 'failed',
      restartHistory: [
        { serviceId: 'localink-core', at: '2026-09-20T11:59:59.000Z' },
      ],
    }),
  );
  assert.equal(transient.action, 'wait_backoff');
  assert.equal(transient.delayMs, 4_000);

  const repeated = decideRecovery(
    recoveryInput({
      core: stoppedCore,
      localMcpReadiness: 'failed',
      restartHistory: [0, 1, 2, 3, 4].map((offset) => ({
        serviceId: 'localink-core' as const,
        at: new Date(
          Date.parse('2026-09-20T11:59:00.000Z') + offset * 1000,
        ).toISOString(),
      })),
    }),
  );
  assert.equal(repeated.action, 'manual_intervention');
  assert.equal(repeated.reasonCode, 'RESTART_STORM_DETECTED');
  assert.equal(repeated.cooldownUntil, '2026-09-20T12:15:00.000Z');
});

test('cooldown, stale state, invalid config, and operator stop remain explicit', () => {
  const cooldown = decideRecovery(
    recoveryInput({
      core: serviceStatus('localink-core', {
        processRunning: false,
        readiness: 'failed',
        cooldownUntil: '2026-09-20T12:01:00.000Z',
      }),
      localMcpReadiness: 'failed',
    }),
  );
  assert.equal(cooldown.action, 'wait_backoff');
  assert.equal(cooldown.delayMs, 60_000);

  const stale = decideRecovery(
    recoveryInput({
      core: serviceStatus('localink-core', {
        processRunning: false,
        pid: 999,
        readiness: 'unknown',
      }),
    }),
  );
  assert.equal(stale.action, 'manual_intervention');
  assert.equal(stale.reasonCode, 'STALE_STATE_REQUIRES_REVIEW');
  assert.equal(
    stale.suggestedCleanup,
    'remove_stale_pid_or_lock_after_owner_check',
  );

  const invalid = decideRecovery(recoveryInput({ tunnelConfig: 'invalid' }));
  assert.equal(invalid.action, 'manual_intervention');
  assert.equal(invalid.serviceId, 'localink-tunnel');

  const stop = decideRecovery(
    recoveryInput({
      operatorIntent: { kind: 'stop', serviceId: 'localink-tunnel' },
    }),
  );
  assert.equal(stop.action, 'stop');
  assert.equal(stop.reasonCode, 'OPERATOR_INTENT');
});

test('injected clock and policy make capped backoff deterministic', () => {
  const stoppedTunnel = serviceStatus('localink-tunnel', {
    processRunning: false,
    readiness: 'failed',
  });
  const input = recoveryInput({
    tunnel: stoppedTunnel,
    now: '2026-09-20T12:00:00.000Z',
    policy: { ...DEFAULT_RECOVERY_POLICY, maxBackoffMs: 10_000 },
    restartHistory: [0, 1, 2, 3].map((offset) => ({
      serviceId: 'localink-tunnel' as const,
      at: new Date(
        Date.parse('2026-09-20T11:59:55.000Z') + offset,
      ).toISOString(),
    })),
  });
  assert.deepEqual(decideRecovery(input), decideRecovery(input));
  const result = decideRecovery(input);
  assert.equal(result.action, 'wait_backoff');
  assert.equal(result.delayMs, 5_003);
  assert.equal(result.oneShot, true);

  const expiredWindow = decideRecovery({
    ...input,
    restartHistory: [
      { serviceId: 'localink-tunnel', at: '2026-09-20T11:00:00.000Z' },
    ],
  });
  assert.equal(expiredWindow.action, 'start');
  assert.equal(expiredWindow.reasonCode, 'TUNNEL_PROCESS_STOPPED');
});

function snapshotFixture(checkedAt: string) {
  return {
    version: 1 as const,
    checkedAt,
    core: {
      installed: true,
      processRunning: true,
      readiness: 'ready' as const,
      reasonCodes: [],
    },
    localMcpReadiness: 'ready' as const,
    tunnel: {
      configured: false,
      secretAvailable: false,
      installed: false,
      processRunning: false,
      binaryAvailable: true,
      versionCompatibility: 'tested' as const,
      profileValid: 'unknown' as const,
      controlPlaneAuth: 'unknown' as const,
      connected: 'unknown' as const,
      ready: 'unknown' as const,
      reasonCodes: ['TUNNEL_NOT_CONFIGURED'],
    },
    recovery: {
      installed: true,
      lastAction: 'none' as const,
    },
    clientBinding: { state: 'not_observable' as const },
  };
}

test('service snapshot is atomic, strict, freshness-aware, and public-safe', async () => {
  await withTemporaryDirectory(async (root) => {
    const checkedAt = '2026-09-21T00:00:00.000Z';
    await writeServiceSnapshot(root, snapshotFixture(checkedAt));
    assert.equal((await stat(serviceSnapshotPath(root))).mode & 0o777, 0o600);
    const fresh = await readServiceSnapshot(root, {
      now: Date.parse(checkedAt) + 1_000,
      freshnessMs: 2_000,
    });
    assert.equal(fresh?.stale, false);
    const stale = await readServiceSnapshot(root, {
      now: Date.parse(checkedAt) + 3_000,
      freshnessMs: 2_000,
    });
    assert.equal(stale?.stale, true);
    const serialized = JSON.stringify(stale);
    for (const privateValue of [
      '/Users/fixture',
      'tunnel_private_id',
      'synthetic-secret',
      'pid',
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
    await writeFile(
      serviceSnapshotPath(root),
      JSON.stringify({ ...snapshotFixture(checkedAt), pid: 99 }),
    );
    assert.equal(await readServiceSnapshot(root), undefined);
  });
});

test('tunnel service config is strict, non-secret, atomic, and fixed to Local MCP', async () => {
  await withTemporaryDirectory(async (root) => {
    const ownedBinary = localinkTunnelClientPath(root);
    const config = createTunnelServiceConfig('tunnel_abcdefgh', {
      tunnelClientPath: ownedBinary,
    });
    await writeTunnelServiceConfig(root, config);
    assert.deepEqual(await readTunnelServiceConfig(root), config);
    const source = await readFile(
      path.join(root, 'config', 'tunnel-service.json'),
      'utf8',
    );
    assert.match(source, /http:\/\/127\.0\.0\.1:4318\/mcp/u);
    assert.match(source, /"version": 2/u);
    assert.equal(config.tunnelClientPath, ownedBinary);
    assert.equal(isLocalinkOwnedTunnelClientPath(root, ownedBinary), true);
    assert.equal(
      isLocalinkOwnedTunnelClientPath(
        root,
        path.resolve(root, '..', '.local', 'bin', 'tunnel-client'),
      ),
      false,
    );
    assert.equal(source.includes('secretRef'), false);
    assert.equal(source.includes('CONTROL_PLANE_API_KEY'), false);
    assert.equal(source.includes('synthetic-secret'), false);
    assert.throws(() =>
      createTunnelServiceConfig('not-a-tunnel', {
        tunnelClientPath: ownedBinary,
      }),
    );
  });
});

test('legacy tunnel service config is accepted only for one-way version-two upgrade', async () => {
  await withTemporaryDirectory(async (root) => {
    const destination = path.join(root, 'config', 'tunnel-service.json');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(
      destination,
      JSON.stringify({
        version: 1,
        profileName: 'localink',
        tunnelId: 'tunnel_abcdefgh',
        localMcpUrl: 'http://127.0.0.1:4318/mcp',
        healthListenAddress: '127.0.0.1:4319',
        secretRef: {
          provider: 'macos-keychain',
          namespace: 'openai-tunnel',
          key: 'runtime-api-key',
        },
      }),
    );
    const upgraded = await readTunnelServiceConfig(root);
    assert.equal(upgraded?.version, 2);
    assert.equal(JSON.stringify(upgraded).includes('secretRef'), false);
    if (upgraded === undefined) throw new Error('Expected upgraded config.');
    const sharedBinary = path.resolve(
      root,
      '..',
      '.local',
      'bin',
      'tunnel-client',
    );
    await mkdir(path.dirname(sharedBinary), { recursive: true });
    await writeFile(sharedBinary, 'shared-binary-sentinel', { mode: 0o755 });
    const sharedBefore = await readFile(sharedBinary, 'utf8');
    await writeTunnelServiceConfig(root, {
      ...upgraded,
      tunnelClientPath: localinkTunnelClientPath(root),
    });
    assert.equal(
      (await readFile(destination, 'utf8')).includes('macos-keychain'),
      false,
    );
    assert.equal(await readFile(sharedBinary, 'utf8'), sharedBefore);
    assert.match(
      await readFile(destination, 'utf8'),
      new RegExp(localinkTunnelClientPath(root).replaceAll('/', '\\/'), 'u'),
    );
  });
});

test('canonical tunnel auth metadata rejects missing, empty, unsafe mode, and symlink files', async () => {
  await withTemporaryDirectory(async (root) => {
    const authFile = tunnelAuthFilePath(root);
    const secretsDirectory = path.dirname(authFile);
    assert.equal(
      authFile,
      path.join(root, 'secrets', 'openai-tunnel-runtime.key'),
    );
    assert.deepEqual(await inspectTunnelAuthFile(root), {
      available: false,
      reasonCode: 'AUTH_FILE_MISSING',
    });
    await mkdir(secretsDirectory, { mode: 0o700 });
    await writeFile(authFile, '', { mode: 0o600 });
    assert.equal(
      (await inspectTunnelAuthFile(root)).reasonCode,
      'AUTH_FILE_EMPTY',
    );
    await writeFile(authFile, 'synthetic-value', { mode: 0o600 });
    assert.deepEqual(await inspectTunnelAuthFile(root), {
      available: true,
      reasonCode: 'AUTH_FILE_READY',
    });
    await chmod(authFile, 0o644);
    assert.equal(
      (await inspectTunnelAuthFile(root)).reasonCode,
      'AUTH_FILE_MODE_INVALID',
    );
    await rm(authFile);
    const target = path.join(root, 'target');
    await writeFile(target, 'synthetic-value', { mode: 0o600 });
    await symlink(target, authFile);
    assert.equal(
      (await inspectTunnelAuthFile(root)).reasonCode,
      'AUTH_FILE_SYMLINK',
    );
  });
});

test('one-time Keychain migration reads once and atomically creates a private auth file', async () => {
  await withTemporaryDirectory(async (root) => {
    const syntheticValue = 'synthetic-migration-value';
    let readCount = 0;
    const result = await migrateLegacyKeychainTunnelAuth(root, {
      async read(service, account) {
        readCount += 1;
        assert.equal(service, 'localink.openai-tunnel');
        assert.equal(account, 'runtime-api-key');
        return syntheticValue;
      },
    });
    const authFile = tunnelAuthFilePath(root);
    assert.equal(readCount, 1);
    assert.deepEqual(result, { migrated: true, authFileAvailable: true });
    assert.equal(JSON.stringify(result).includes(syntheticValue), false);
    assert.equal(JSON.stringify(result).includes(authFile), false);
    assert.equal(await readFile(authFile, 'utf8'), syntheticValue);
    assert.equal((await stat(path.dirname(authFile))).mode & 0o777, 0o700);
    assert.equal((await stat(authFile)).mode & 0o777, 0o600);
    await assert.rejects(
      migrateLegacyKeychainTunnelAuth(root, {
        async read() {
          readCount += 1;
          return syntheticValue;
        },
      }),
      /already exists/u,
    );
    assert.equal(readCount, 1);
  });
});

test('real Keychain adapter separates metadata existence from secret reads with fixed security argv', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const adapter = new MacOSKeychainAdapter({
    async execute(command, args) {
      calls.push({ command, args });
      return { stdout: 'synthetic-secret\n' };
    },
  });
  assert.equal(
    await adapter.read('localink.openai-tunnel', 'runtime-api-key'),
    'synthetic-secret',
  );
  assert.deepEqual(calls, [
    {
      command: '/usr/bin/security',
      args: [
        'find-generic-password',
        '-s',
        'localink.openai-tunnel',
        '-a',
        'runtime-api-key',
        '-w',
      ],
    },
  ]);
  calls.length = 0;
  assert.equal(
    await adapter.exists('localink.openai-tunnel', 'runtime-api-key'),
    true,
  );
  assert.deepEqual(calls, [
    {
      command: '/usr/bin/security',
      args: [
        'find-generic-password',
        '-s',
        'localink.openai-tunnel',
        '-a',
        'runtime-api-key',
      ],
    },
  ]);
  assert.equal(calls[0]?.args.includes('-w'), false);
  const failing = new MacOSKeychainAdapter({
    async execute() {
      throw new Error('synthetic-secret should be hidden');
    },
  });
  await assert.rejects(
    failing.read('localink.openai-tunnel', 'runtime-api-key'),
    (error) =>
      error instanceof Error && !error.message.includes('synthetic-secret'),
  );
  await assert.rejects(
    failing.exists('localink.openai-tunnel', 'runtime-api-key'),
    (error) =>
      error instanceof Error &&
      error.message === 'Keychain availability check failed.' &&
      !error.message.includes('synthetic-secret'),
  );
  const missing = new MacOSKeychainAdapter({
    async execute() {
      throw Object.assign(new Error('not found'), { code: 44 });
    },
  });
  assert.equal(
    await missing.read('localink.openai-tunnel', 'runtime-api-key'),
    undefined,
  );
  assert.equal(
    await missing.exists('localink.openai-tunnel', 'runtime-api-key'),
    false,
  );
});

test('service controller writes only managed plists and executes fixed launchctl argv', async () => {
  await withTemporaryDirectory(async (root) => {
    const context = fixtureContext(root);
    await mkdir(path.dirname(context.localinkExecutablePath), {
      recursive: true,
    });
    await mkdir(context.runtimePath, { recursive: true });
    await writeFile(context.localinkExecutablePath, '#!/bin/sh\n', {
      mode: 0o700,
    });
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor: FixedCommandExecutor = {
      async execute(command, args) {
        calls.push({ command, args });
        if (
          command === '/bin/launchctl' &&
          args[0] === 'print' &&
          args.length === 2 &&
          args[1] !== context.launchdDomain
        ) {
          throw Object.assign(new Error('missing'), { code: 113 });
        }
        return { stdout: '{}', stderr: '' };
      },
    };
    const controller = new LocalServiceController(
      context,
      new LaunchctlExecutor(executor),
      executor,
      () => 501,
    );
    const receipt = await controller.bootstrap(false);
    assert.deepEqual(receipt.bootstrapped, [
      'localink-core',
      'localink-recovery',
    ]);
    assert.deepEqual(receipt.skipped, ['localink-tunnel']);
    assert.equal(receipt.requiresRoot, false);
    assert.equal(
      calls.some(
        ({ command, args }) =>
          command === '/bin/launchctl' &&
          args[0] === 'bootstrap' &&
          args[1] === 'gui/501',
      ),
      true,
    );
    const corePlist = await readFile(
      path.join(context.launchAgentsDirectory, 'com.localink.core.plist'),
      'utf8',
    );
    assert.match(corePlist, /Managed by Localink/u);
    assert.equal(corePlist.includes('CONTROL_PLANE_API_KEY'), false);

    await writeFile(
      path.join(context.launchAgentsDirectory, 'com.localink.unknown.plist'),
      'unknown',
    );
    await assert.rejects(
      controller.preflight(),
      (error) =>
        error instanceof ServiceFoundationError &&
        error.code === 'SERVICE_PREFLIGHT_FAILED',
    );
    const rootController = new LocalServiceController(
      context,
      new LaunchctlExecutor(executor),
      executor,
      () => 0,
    );
    await assert.rejects(
      rootController.preflight(),
      (error) =>
        error instanceof ServiceFoundationError &&
        error.code === 'SERVICE_PREFLIGHT_FAILED',
    );
  });
});

test('stable-prefix rebootstrap replaces all Localink services in bounded dependency order', async () => {
  await withTemporaryDirectory(async (root) => {
    const userHome = path.join(root, 'home');
    const localinkRoot = path.join(userHome, '.localink');
    const context = createInstallationContext({
      installPrefix: path.join(localinkRoot, 'app', 'current'),
      localinkExecutablePath: path.join(localinkRoot, 'bin', 'localink'),
      localinkEntrypointArguments: [],
      runtimePath: path.join(localinkRoot, 'app', 'current', 'payload'),
      stateRoot: localinkRoot,
      configRoot: path.join(localinkRoot, 'config'),
      logRoot: path.join(localinkRoot, 'logs'),
      userHome,
      launchAgentsDirectory: path.join(userHome, 'Library', 'LaunchAgents'),
      uid: 501,
    });
    await mkdir(path.dirname(context.localinkExecutablePath), {
      recursive: true,
    });
    await mkdir(context.runtimePath, { recursive: true });
    await writeFile(context.localinkExecutablePath, '#!/bin/sh\n', {
      mode: 0o700,
    });
    const loaded = new Set<string>();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor: FixedCommandExecutor = {
      async execute(command, args) {
        calls.push({ command, args });
        if (command === '/usr/bin/plutil')
          return { stdout: 'OK\n', stderr: '' };
        if (args[0] === 'print' && args[1] === context.launchdDomain) {
          return { stdout: [...loaded].join('\n'), stderr: '' };
        }
        if (args[0] === 'print') {
          const label = String(args[1]).split('/').at(-1)!;
          if (!loaded.has(label))
            throw Object.assign(new Error('missing'), { code: 113 });
          return { stdout: 'state = running\npid = 123\n', stderr: '' };
        }
        if (args[0] === 'bootstrap') {
          loaded.add(path.basename(String(args[2]), '.plist'));
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'bootout') {
          loaded.delete(String(args[1]).split('/').at(-1)!);
          return { stdout: '', stderr: '' };
        }
        throw new Error('unexpected command');
      },
    };
    const controller = new LocalServiceController(
      context,
      new LaunchctlExecutor(executor),
      executor,
      () => 501,
    );
    await controller.bootstrap(true);
    calls.length = 0;
    const receipt = await controller.rebootstrap(true);
    assert.deepEqual(receipt.bootstrapped, [
      'localink-core',
      'localink-tunnel',
      'localink-recovery',
    ]);
    assert.deepEqual(receipt.skipped, []);
    const transitions = calls
      .filter(
        ({ command, args }) =>
          command === '/bin/launchctl' &&
          (args[0] === 'bootout' || args[0] === 'bootstrap'),
      )
      .map(({ args }) => args[0]);
    assert.deepEqual(transitions, [
      'bootout',
      'bootout',
      'bootout',
      'bootstrap',
      'bootstrap',
      'bootstrap',
    ]);
    for (const definition of createServiceDefinitions(context)) {
      assert.equal(
        definition.ProgramArguments[0],
        path.join(localinkRoot, 'bin', 'localink'),
      );
      assert.equal(
        definition.WorkingDirectory,
        path.join(localinkRoot, 'app', 'current', 'payload'),
      );
      assert.equal(
        definition.ProgramArguments.join(' ').includes('/repo/'),
        false,
      );
    }
  });
});

test('bootstrapTunnel starts only Tunnel after a core-only rebootstrap', async () => {
  await withTemporaryDirectory(async (root) => {
    const context = fixtureContext(root);
    await mkdir(path.dirname(context.localinkExecutablePath), {
      recursive: true,
    });
    await mkdir(context.runtimePath, { recursive: true });
    await mkdir(context.launchAgentsDirectory, { recursive: true });
    await writeFile(context.localinkExecutablePath, '#!/bin/sh\n', {
      mode: 0o700,
    });
    const loaded = new Set<string>();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor: FixedCommandExecutor = {
      async execute(command, args) {
        calls.push({ command, args });
        if (command === '/usr/bin/plutil')
          return { stdout: 'OK\n', stderr: '' };
        if (args[0] === 'print' && args[1] === context.launchdDomain)
          return { stdout: [...loaded].join('\n'), stderr: '' };
        if (args[0] === 'print') {
          const label = String(args[1]).split('/').at(-1)!;
          if (!loaded.has(label))
            throw Object.assign(new Error('missing'), { code: 113 });
          return { stdout: 'state = running\npid = 123\n', stderr: '' };
        }
        if (args[0] === 'bootstrap') {
          loaded.add(path.basename(String(args[2]), '.plist'));
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'bootout') {
          loaded.delete(String(args[1]).split('/').at(-1)!);
          return { stdout: '', stderr: '' };
        }
        throw new Error('unexpected command');
      },
    };
    const controller = new LocalServiceController(
      context,
      new LaunchctlExecutor(executor),
      executor,
      () => 501,
    );
    await controller.rebootstrap(false);
    calls.length = 0;
    const receipt = await controller.bootstrapTunnel();
    assert.deepEqual(receipt.bootstrapped, ['localink-tunnel']);
    assert.deepEqual(receipt.skipped, ['localink-core', 'localink-recovery']);
    const bootstrappedLabels = calls
      .filter(
        ({ command, args }) =>
          command === '/bin/launchctl' && args[0] === 'bootstrap',
      )
      .map(({ args }) => path.basename(String(args[2]), '.plist'));
    assert.deepEqual(bootstrappedLabels, ['com.localink.tunnel']);
  });
});

interface TransitionFixture {
  readonly controller: LocalServiceController;
  readonly events: string[];
  readonly elapsed: () => number;
}

async function withTransitionFixture(
  options: {
    readonly unloadAfter?: number;
    readonly registerAfter?: number;
    readonly registeredRunning?: boolean;
    readonly fail?: 'bootout' | 'bootstrap';
  },
  worker: (fixture: TransitionFixture) => Promise<void>,
): Promise<void> {
  await withTemporaryDirectory(async (root) => {
    const context = fixtureContext(root);
    await mkdir(path.dirname(context.localinkExecutablePath), {
      recursive: true,
    });
    await mkdir(context.runtimePath, { recursive: true });
    await mkdir(context.launchAgentsDirectory, { recursive: true });
    await writeFile(context.localinkExecutablePath, '#!/bin/sh\n', {
      mode: 0o700,
    });
    const artifacts = createLaunchAgentArtifacts(context);
    for (const artifact of artifacts)
      await writeFile(artifact.destinationPath, artifact.contents);
    const loaded = new Set(artifacts.map((artifact) => artifact.label));
    const unloading = new Map<string, number>();
    const registering = new Map<string, number>();
    const events: string[] = [];
    let current = 0;
    const executor: FixedCommandExecutor = {
      async execute(command, args) {
        if (command === '/usr/bin/plutil')
          return { stdout: 'OK\n', stderr: '' };
        const operation = args[0];
        if (operation === 'print' && args[1] === context.launchdDomain)
          return { stdout: [...loaded].join('\n'), stderr: '' };
        const label =
          operation === 'bootstrap'
            ? path.basename(String(args[2]), '.plist')
            : String(args.at(-1)).split('/').at(-1)!;
        if (operation === 'print') {
          if (unloading.has(label)) {
            const remaining = unloading.get(label)! - 1;
            if (remaining <= 0) {
              unloading.delete(label);
              loaded.delete(label);
            } else unloading.set(label, remaining);
          }
          if (registering.has(label)) {
            const remaining = registering.get(label)! - 1;
            if (remaining <= 0) {
              registering.delete(label);
              loaded.add(label);
            } else registering.set(label, remaining);
          }
          events.push(
            `print:${label}:${loaded.has(label) ? 'present' : 'absent'}`,
          );
          if (!loaded.has(label))
            throw Object.assign(new Error('not registered'), { code: 113 });
          return {
            stdout:
              options.registeredRunning === false
                ? 'state = waiting\n'
                : 'state = running\npid = 123\n',
            stderr: '',
          };
        }
        if (operation === 'bootout') {
          events.push(`bootout:${label}`);
          if (options.fail === 'bootout')
            throw new Error('synthetic raw launchctl secret');
          unloading.set(label, options.unloadAfter ?? 1);
          return { stdout: '', stderr: '' };
        }
        if (operation === 'bootstrap') {
          events.push(`bootstrap:${label}`);
          if (options.fail === 'bootstrap')
            throw new Error('synthetic raw launchctl secret');
          registering.set(label, options.registerAfter ?? 1);
          return { stdout: '', stderr: '' };
        }
        throw new Error('unexpected command');
      },
    };
    const controller = new LocalServiceController(
      context,
      new LaunchctlExecutor(executor),
      executor,
      () => 501,
      {
        now: () => current,
        sleep: async (ms) => {
          current += ms;
        },
      },
    );
    await worker({ controller, events, elapsed: () => current });
  });
}

test('rebootstrap confirms immediate unload and registration in service order', async () => {
  await withTransitionFixture({}, async ({ controller, events, elapsed }) => {
    const receipt = await controller.rebootstrap(true);
    assert.deepEqual(receipt.bootstrapped, [
      'localink-core',
      'localink-tunnel',
      'localink-recovery',
    ]);
    assert.equal(elapsed(), 0);
    const firstBootstrap = events.findIndex((event) =>
      event.startsWith('bootstrap:'),
    );
    assert.ok(firstBootstrap > 0);
    for (const label of Object.values(SERVICE_LABELS))
      assert.ok(events.indexOf(`print:${label}:absent`) < firstBootstrap);
  });
});

test('rebootstrap waits for the third unload probe before any bootstrap', async () => {
  await withTransitionFixture(
    { unloadAfter: 3 },
    async ({ controller, events, elapsed }) => {
      await controller.rebootstrap(true);
      const firstBootstrap = events.findIndex((event) =>
        event.startsWith('bootstrap:'),
      );
      assert.ok(firstBootstrap > 0);
      for (const label of Object.values(SERVICE_LABELS)) {
        assert.ok(events.indexOf(`print:${label}:absent`) < firstBootstrap);
        assert.equal(
          events.filter((event) => event === `print:${label}:present`).length >=
            3,
          true,
        );
      }
      assert.equal(elapsed(), 450);
    },
  );
});

test('rebootstrap stops before bootstrap when unload never completes', async () => {
  await withTransitionFixture(
    { unloadAfter: Infinity },
    async ({ controller, events, elapsed }) => {
      await assert.rejects(
        controller.rebootstrap(true),
        (error) =>
          error instanceof ServiceFoundationError &&
          error.code === 'LAUNCHCTL_UNLOAD_TIMEOUT',
      );
      assert.equal(
        events.some((event) => event.startsWith('bootstrap:')),
        false,
      );
      assert.equal(elapsed(), 5_000);
    },
  );
});

test('rebootstrap preserves typed bootout and bootstrap command failures without raw output', async () => {
  for (const [fail, code] of [
    ['bootout', 'LAUNCHCTL_BOOTOUT_FAILED'],
    ['bootstrap', 'LAUNCHCTL_BOOTSTRAP_FAILED'],
  ] as const) {
    await withTransitionFixture({ fail }, async ({ controller }) => {
      await assert.rejects(
        controller.rebootstrap(true),
        (error) =>
          error instanceof ServiceFoundationError &&
          error.code === code &&
          !error.message.includes('synthetic raw launchctl secret'),
      );
    });
  }
});

test('rebootstrap waits for delayed registration without requiring process readiness', async () => {
  await withTransitionFixture(
    { registerAfter: 3, registeredRunning: false },
    async ({ controller, events, elapsed }) => {
      await controller.rebootstrap(true);
      for (const label of Object.values(SERVICE_LABELS))
        assert.ok(events.includes(`print:${label}:absent`));
      assert.equal(elapsed(), 450);
    },
  );
});

test('rebootstrap reports registration timeout after successful bootstrap', async () => {
  await withTransitionFixture(
    { registerAfter: Infinity },
    async ({ controller, events, elapsed }) => {
      await assert.rejects(
        controller.rebootstrap(true),
        (error) =>
          error instanceof ServiceFoundationError &&
          error.code === 'LAUNCHCTL_REGISTRATION_TIMEOUT',
      );
      assert.ok(events.some((event) => event.startsWith('bootstrap:')));
      assert.equal(elapsed(), 5_000);
    },
  );
});

test('long-lived tunnel wrapper waits, forwards signals, and reports child exit without secret leakage', async () => {
  await withTemporaryDirectory(async (root) => {
    const emitter = new EventEmitter();
    let finish:
      | ((value: {
          exitCode: number | null;
          signal: NodeJS.Signals | null;
        }) => void)
      | undefined;
    const signaled: NodeJS.Signals[] = [];
    const launcher: TunnelChildLauncher = {
      async launch() {
        return {
          pid: 404,
          wait: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
          signal(value) {
            signaled.push(value);
            return true;
          },
        };
      },
    };
    const running = runTunnelWrapper(
      {
        binaryPath: path.join(root, 'tunnel-client'),
        profileName: 'localink',
        profileDirectory: path.join(root, 'profiles'),
        workingDirectory: root,
      },
      launcher,
      { signalEmitter: emitter as unknown as NodeJS.Process, shutdownMs: 50 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    emitter.emit('SIGTERM');
    assert.deepEqual(signaled, ['SIGTERM']);
    finish?.({ exitCode: 7, signal: null });
    const result = await running;
    assert.equal(result.exitCode, 7);
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
    assert.equal(emitter.listenerCount('SIGTERM'), 0);
  });
});

test('recovery executor performs at most one mutation and persists backoff/manual state', async () => {
  await withTemporaryDirectory(async (root) => {
    const mutations: string[] = [];
    const snapshots: RecoveryDecision[] = [];
    const stoppedCore = serviceStatus('localink-core', {
      processRunning: false,
      readiness: 'failed',
    });
    const dependencies = {
      stateRoot: root,
      now: () => new Date('2026-09-21T00:00:00.000Z'),
      collect: async () => ({
        core: stoppedCore,
        localMcpReadiness: 'failed' as const,
        tunnel: serviceStatus('localink-tunnel', { processRunning: false }),
        tunnelConnected: 'unknown' as const,
        tunnelReady: 'unknown' as const,
        tunnelAuth: 'unknown' as const,
        coreConfig: 'valid' as const,
        tunnelConfig: 'unknown' as const,
        tunnelSecret: 'missing' as const,
      }),
      mutate: async (serviceId: string, action: string) => {
        mutations.push(`${serviceId}:${action}`);
      },
      writeSnapshot: async (decision: RecoveryDecision) => {
        snapshots.push(decision);
      },
    };
    const first = await executeRecoveryOnce(dependencies);
    assert.equal(first.action, 'start');
    assert.deepEqual(mutations, ['localink-core:start']);
    assert.equal(snapshots.length, 1);
    const second = await executeRecoveryOnce({
      ...dependencies,
      now: () => new Date('2026-09-21T00:00:01.000Z'),
    });
    assert.equal(second.action, 'wait_backoff');
    assert.equal(mutations.length, 1);
    assert.equal(snapshots.length, 2);
  });
});

test('live recovery execution keeps tunnel prerequisites manual and restarts tunnel only after Core readiness', async () => {
  await withTemporaryDirectory(async (root) => {
    const readyCore = serviceStatus('localink-core');
    const failedTunnel = serviceStatus('localink-tunnel', {
      readiness: 'failed',
    });
    const mutations: string[] = [];
    const common = {
      core: readyCore,
      localMcpReadiness: 'ready' as const,
      tunnel: failedTunnel,
      tunnelConnected: 'failed' as const,
      tunnelReady: 'failed' as const,
      coreConfig: 'valid' as const,
    };
    const manual = await executeRecoveryOnce({
      stateRoot: path.join(root, 'manual'),
      now: () => new Date('2026-09-21T00:00:00.000Z'),
      collect: async () => ({
        ...common,
        tunnelAuth: 'unknown' as const,
        tunnelConfig: 'unknown' as const,
        tunnelSecret: 'missing' as const,
      }),
      mutate: async (serviceId, action) => {
        mutations.push(`${serviceId}:${action}`);
      },
      writeSnapshot: async () => undefined,
    });
    assert.equal(manual.action, 'manual_intervention');
    assert.equal(manual.reasonCode, 'TUNNEL_SECRET_MISSING');
    assert.equal(mutations.length, 0);

    const restarted = await executeRecoveryOnce({
      stateRoot: path.join(root, 'restart'),
      now: () => new Date('2026-09-21T00:00:00.000Z'),
      collect: async () => ({
        ...common,
        tunnelAuth: 'ready' as const,
        tunnelConfig: 'valid' as const,
        tunnelSecret: 'available' as const,
      }),
      mutate: async (serviceId, action) => {
        mutations.push(`${serviceId}:${action}`);
      },
      writeSnapshot: async () => undefined,
    });
    assert.equal(restarted.action, 'restart');
    assert.deepEqual(mutations, ['localink-tunnel:restart']);
  });
});
