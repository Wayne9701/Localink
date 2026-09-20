import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  SecretMutationReceipt,
  SecretProvider,
  SecretRef,
  SecretValueHandle,
} from '@localink/sdk';
import {
  DEFAULT_RECOVERY_POLICY,
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
  createUninstallPlan,
  decideRecovery,
  dispatchServiceEntrypoint,
  renderLaunchAgentPlist,
  runTunnelWrapper,
  type InstallationContext,
  type RecoveryInput,
  type ServiceStatus,
  type TunnelChildLauncher,
} from '../src/index.js';

class SyntheticSecret implements SecretValueHandle {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): '[REDACTED]' {
    return '[REDACTED]';
  }
}

class FakeSecretProvider implements SecretProvider {
  readonly id: string;
  readonly #value: string | undefined;

  constructor(id: string, value?: string) {
    this.id = id;
    this.#value = value;
  }

  async get(ref: SecretRef): Promise<SecretValueHandle | undefined> {
    return ref.provider === this.id && this.#value !== undefined
      ? new SyntheticSecret(this.#value)
      : undefined;
  }

  async set(): Promise<SecretMutationReceipt> {
    throw new Error('not implemented by deterministic fake');
  }

  async delete(): Promise<SecretMutationReceipt> {
    throw new Error('not implemented by deterministic fake');
  }
}

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

test('tunnel wrapper reveals a synthetic secret only inside the injected launch boundary', async () => {
  await withTemporaryDirectory(async (root) => {
    const syntheticSecret = 'synthetic-service-secret';
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
      shell: false;
    }> = [];
    const launcher: TunnelChildLauncher = {
      async launch(command, args, options) {
        calls.push({ command, args, env: options.env, shell: options.shell });
        return { pid: 404 };
      },
    };
    const receipt = await runTunnelWrapper(
      {
        binaryPath: path.join(root, 'bin', 'tunnel-client'),
        profileName: 'localink',
        profileDirectory: path.join(root, 'profiles'),
        workingDirectory: root,
        secretRef: { provider: 'fake', key: 'runtime-api-key' },
        baseEnvironment: { LANG: 'C' },
      },
      new FakeSecretProvider('fake', syntheticSecret),
      launcher,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.env.CONTROL_PLANE_API_KEY, syntheticSecret);
    assert.equal(calls[0]?.shell, false);
    assert.deepEqual(calls[0]?.args, ['run', '--profile', 'localink']);
    assert.equal(JSON.stringify(receipt).includes(syntheticSecret), false);
    assert.equal(JSON.stringify(receipt).includes('runtime-api-key'), false);
    assert.deepEqual(receipt.injectedEnvironmentKeys, [
      'CONTROL_PLANE_API_KEY',
    ]);
  });
});

test('tunnel wrapper fails visibly for missing or mismatched synthetic providers', async () => {
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
      secretRef: { provider: 'fake', key: 'runtime-api-key' },
    };
    for (const provider of [
      new FakeSecretProvider('fake'),
      new FakeSecretProvider('other', 'synthetic-service-secret'),
    ]) {
      await assert.rejects(
        runTunnelWrapper(input, provider, launcher),
        (error) =>
          error instanceof ServiceFoundationError &&
          error.code === 'TUNNEL_SECRET_UNAVAILABLE' &&
          !error.message.includes('synthetic-service-secret'),
      );
    }
    await assert.rejects(
      runTunnelWrapper(
        {
          ...input,
          baseEnvironment: { CONTROL_PLANE_API_KEY: 'bypass' },
        },
        new FakeSecretProvider('fake', 'synthetic-service-secret'),
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
