#!/usr/bin/env node

import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  FilesService,
  MacOSKeychainSecretProvider,
  ProcessManager,
  WorkspaceRegistry,
  createStatePaths,
} from '@localink/core';
import { createLocalinkRuntime } from '@localink/runtime';
import { LocalinkError, LOCALINK_VERSION } from '@localink/sdk';
import {
  httpOptionsFromEnv,
  PROTOCOL_VERSION,
  startHttpServer,
  TOOL_NAMES,
} from '@localink/mcp-server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  buildDoctorCommand,
  buildTunnelStatus,
  discoverTunnelClient,
  executeShortLivedCommand,
  parseDoctorOutput,
  resolveTunnelSecretEnvironment,
  TunnelProfileStore,
  type DoctorLayerResult,
  type TunnelBinaryStatus,
  type TunnelStatus,
} from '@localink/openai-tunnel';
import {
  LocalServiceController,
  MacOSKeychainAdapter,
  SystemTunnelChildLauncher,
  createInstallationContext,
  createTunnelServiceConfig,
  executeRecoveryOnce,
  readTunnelServiceConfig,
  runTunnelWrapper,
  writeServiceSnapshot,
  writeTunnelServiceConfig,
  type InstallationContext,
  type PublicServiceSnapshot,
  type RecoveryDecision,
  type ServiceReadiness,
  type ServiceStatus,
  type ServiceSnapshotInput,
  type TunnelServiceConfig,
} from '@localink/service';

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const DEFAULT_MCP_URL = new URL('http://127.0.0.1:4318/mcp');

function stateRoot(): string {
  return path.resolve(
    process.env.LOCALINK_STATE_ROOT ?? path.join(homedir(), '.localink'),
  );
}

function installationContext(): InstallationContext {
  const executable = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(executable), '../../../..');
  const root = stateRoot();
  const userHome = homedir();
  return createInstallationContext({
    installPrefix: repoRoot,
    localinkExecutablePath: process.execPath,
    localinkEntrypointArguments: [executable],
    runtimePath: repoRoot,
    stateRoot: root,
    configRoot: process.env.LOCALINK_CONFIG_ROOT ?? path.join(root, 'config'),
    logRoot: process.env.LOCALINK_LOG_ROOT ?? path.join(root, 'logs'),
    userHome,
    launchAgentsDirectory: path.join(userHome, 'Library', 'LaunchAgents'),
    uid: process.getuid?.() ?? 0,
  });
}

function within<T>(operation: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Operation timed out.')),
      timeoutMs,
    );
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface McpProbe {
  readonly readiness: ServiceReadiness;
  readonly toolCount?: number;
  readonly health?: Record<string, unknown>;
  readonly reasonCodes: readonly string[];
}

async function probeLocalMcp(url = DEFAULT_MCP_URL): Promise<McpProbe> {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(
    { name: 'localink-doctor', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  try {
    await within(client.connect(transport), 5_000);
    const listed = await within(client.listTools(), 5_000);
    const called = await within(
      client.callTool({ name: 'localink.health_status', arguments: {} }),
      5_000,
    );
    const envelope = called.structuredContent;
    const health =
      typeof envelope === 'object' &&
      envelope !== null &&
      !Array.isArray(envelope) &&
      typeof (envelope as Record<string, unknown>).data === 'object' &&
      (envelope as Record<string, unknown>).data !== null
        ? ((envelope as Record<string, unknown>).data as Record<
            string,
            unknown
          >)
        : undefined;
    if (
      called.isError === true ||
      health === undefined ||
      listed.tools.length !== TOOL_NAMES.length
    ) {
      return {
        readiness: 'failed',
        toolCount: listed.tools.length,
        reasonCodes: ['LOCAL_MCP_CONTRACT_FAILED'],
      };
    }
    return {
      readiness: 'ready',
      toolCount: listed.tools.length,
      health,
      reasonCodes: [],
    };
  } catch {
    return { readiness: 'failed', reasonCodes: ['LOCAL_MCP_UNAVAILABLE'] };
  } finally {
    await client.close().catch(() => transport.close());
  }
}

function keychainProvider(): MacOSKeychainSecretProvider {
  return new MacOSKeychainSecretProvider(new MacOSKeychainAdapter());
}

async function secretAvailable(
  config: TunnelServiceConfig | undefined,
): Promise<boolean> {
  if (config === undefined) return false;
  try {
    return (await keychainProvider().get(config.secretRef)) !== undefined;
  } catch {
    return false;
  }
}

interface TunnelInspection {
  readonly configured: boolean;
  readonly secretAvailable: boolean;
  readonly configState: 'valid' | 'invalid' | 'unknown';
  readonly config?: TunnelServiceConfig;
  readonly binary: TunnelBinaryStatus;
  readonly status: TunnelStatus;
}

async function inspectTunnel(localMcp: McpProbe): Promise<TunnelInspection> {
  let config: TunnelServiceConfig | undefined;
  let configState: TunnelInspection['configState'] = 'unknown';
  try {
    config = await readTunnelServiceConfig(stateRoot());
    configState = config === undefined ? 'unknown' : 'valid';
  } catch {
    configState = 'invalid';
  }
  const binary = await discoverTunnelClient({
    ...(config?.tunnelClientPath === undefined
      ? {}
      : { explicitPath: config.tunnelClientPath }),
  });
  const hasSecret = await secretAvailable(config);
  let doctor: DoctorLayerResult | undefined;
  if (config !== undefined) {
    let profileValid: ServiceReadiness = 'ready';
    try {
      await access(
        new TunnelProfileStore(stateRoot()).profilePath(config.profileName),
      );
    } catch {
      profileValid = 'failed';
    }
    doctor = {
      profileValid,
      tunnelIdPresent: 'ready',
      localMcpConfigured: 'ready',
      localMcpReachable: localMcp.readiness,
      controlPlaneAuth: 'unknown',
      tunnelConnected: 'unknown',
      tunnelReady: 'unknown',
      reasonCodes: profileValid === 'ready' ? [] : ['TUNNEL_PROFILE_MISSING'],
    };
  } else if (configState === 'invalid') {
    doctor = {
      profileValid: 'failed',
      tunnelIdPresent: 'unknown',
      localMcpConfigured: 'unknown',
      localMcpReachable: localMcp.readiness,
      controlPlaneAuth: 'unknown',
      tunnelConnected: 'unknown',
      tunnelReady: 'unknown',
      reasonCodes: ['TUNNEL_CONFIG_INVALID'],
    };
  }
  if (
    config !== undefined &&
    hasSecret &&
    binary.available &&
    binary.binaryPath !== undefined &&
    binary.compatibility !== 'unsupported'
  ) {
    try {
      const secretEnvironment = await resolveTunnelSecretEnvironment(
        keychainProvider(),
        config.secretRef,
      );
      const command = buildDoctorCommand(
        binary.binaryPath,
        config.profileName,
        {
          profileDirectory: new TunnelProfileStore(stateRoot())
            .profileDirectory,
          json: true,
        },
      );
      const result = await executeShortLivedCommand({
        ...command,
        environmentOverrides: Object.fromEntries(
          Object.entries(
            secretEnvironment.forSpawn(command.environmentOverrides),
          ).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      });
      doctor = parseDoctorOutput(result.stdout);
    } catch {
      doctor = {
        profileValid: 'unknown' as const,
        tunnelIdPresent: 'unknown' as const,
        localMcpConfigured: 'unknown' as const,
        localMcpReachable: localMcp.readiness,
        controlPlaneAuth: 'failed' as const,
        tunnelConnected: 'failed' as const,
        tunnelReady: 'failed' as const,
        reasonCodes: ['TUNNEL_DOCTOR_FAILED'],
      };
    }
  }
  return {
    configured: config !== undefined,
    secretAvailable: hasSecret,
    configState,
    ...(config === undefined ? {} : { config }),
    binary,
    status: buildTunnelStatus(binary, doctor),
  };
}

interface LiveInspection {
  readonly checkedAt: string;
  readonly core: ServiceStatus;
  readonly recovery: ServiceStatus;
  readonly tunnelService: ServiceStatus;
  readonly localMcp: McpProbe;
  readonly tunnel: TunnelInspection;
}

async function inspectLive(): Promise<LiveInspection> {
  const checkedAt = new Date().toISOString();
  const controller = new LocalServiceController(installationContext());
  const [localMcp, coreRaw, recovery, tunnelService] = await Promise.all([
    probeLocalMcp(),
    controller.status('localink-core', 'unknown', checkedAt),
    controller.status('localink-recovery', 'unknown', checkedAt),
    controller.status('localink-tunnel', 'unknown', checkedAt),
  ]);
  const core = { ...coreRaw, readiness: localMcp.readiness };
  const tunnel = await inspectTunnel(localMcp);
  return { checkedAt, core, recovery, tunnelService, localMcp, tunnel };
}

function snapshotFromInspection(
  inspection: LiveInspection,
  decision?: RecoveryDecision,
): ServiceSnapshotInput {
  const tunnelReasons = new Set([
    ...inspection.tunnel.binary.reasonCodes,
    ...inspection.tunnel.status.reasonCodes,
    ...(inspection.tunnel.configured ? [] : ['TUNNEL_NOT_CONFIGURED']),
    ...(inspection.tunnel.secretAvailable ? [] : ['TUNNEL_SECRET_MISSING']),
  ]);
  return {
    version: 1,
    checkedAt: inspection.checkedAt,
    core: {
      installed: inspection.core.installed,
      processRunning: inspection.core.processRunning,
      readiness: inspection.localMcp.readiness,
      reasonCodes: [
        ...new Set([
          ...inspection.core.reasonCodes,
          ...inspection.localMcp.reasonCodes,
        ]),
      ],
    },
    localMcpReadiness: inspection.localMcp.readiness,
    tunnel: {
      configured: inspection.tunnel.configured,
      secretAvailable: inspection.tunnel.secretAvailable,
      installed: inspection.tunnelService.installed,
      processRunning: inspection.tunnelService.processRunning,
      binaryAvailable: inspection.tunnel.binary.available,
      versionCompatibility: inspection.tunnel.binary.compatibility,
      profileValid: inspection.tunnel.status.profileValid,
      controlPlaneAuth: inspection.tunnel.status.controlPlaneAuth,
      connected: inspection.tunnel.status.tunnel.connected,
      ready: inspection.tunnel.status.tunnel.ready,
      reasonCodes: [...tunnelReasons],
    },
    recovery: {
      installed: inspection.recovery.installed,
      lastAction: decision?.action ?? 'none',
      ...(decision?.reasonCode === undefined
        ? {}
        : { reasonCode: decision.reasonCode }),
      ...(decision?.cooldownUntil === undefined
        ? {}
        : { cooldownUntil: decision.cooldownUntil }),
    },
    clientBinding: { state: 'not_observable' },
  };
}

async function writeCurrentSnapshot(
  inspection: LiveInspection,
  decision?: RecoveryDecision,
): Promise<PublicServiceSnapshot> {
  return writeServiceSnapshot(
    stateRoot(),
    snapshotFromInspection(inspection, decision),
  );
}

async function doctor(): Promise<void> {
  const inspection = await inspectLive();
  const service = await writeCurrentSnapshot(inspection);
  output({
    checkedAt: inspection.checkedAt,
    localService: {
      core: service.core,
      recovery: service.recovery,
      tunnel: {
        installed: service.tunnel.installed,
        processRunning: service.tunnel.processRunning,
      },
    },
    localMcp: {
      readiness: inspection.localMcp.readiness,
      toolCount: inspection.localMcp.toolCount,
      expectedToolCount: TOOL_NAMES.length,
      reasonCodes: inspection.localMcp.reasonCodes,
    },
    tunnel: service.tunnel,
    sharedAssets: inspection.localMcp.health?.sharedAssets ?? {
      state: 'unknown',
    },
    clientBinding: service.clientBinding,
  });
}

async function assertHealthPortAvailable(address: string): Promise<void> {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/u.exec(address);
  if (match === null) throw new Error('Invalid tunnel health address.');
  const host = match[1] === '[::1]' ? '::1' : match[1];
  const port = Number(match[2]);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function configureTunnel(tunnelId: string): Promise<void> {
  const binary = await discoverTunnelClient();
  if (
    !binary.available ||
    binary.binaryPath === undefined ||
    binary.compatibility === 'unsupported'
  )
    throw new Error('A supported tunnel-client binary is required.');
  const config = createTunnelServiceConfig(tunnelId, {
    tunnelClientPath: binary.binaryPath,
  });
  await assertHealthPortAvailable(config.healthListenAddress);
  const profile = new TunnelProfileStore(stateRoot());
  await profile.write({
    name: config.profileName,
    tunnelId: config.tunnelId,
    apiKeySecretRef: config.secretRef,
    localMcpUrl: config.localMcpUrl,
    healthListenAddress: config.healthListenAddress,
  });
  await writeTunnelServiceConfig(stateRoot(), config);
  output({
    configured: true,
    profileName: config.profileName,
    binaryAvailable: true,
    versionCompatibility: binary.compatibility,
    secretAvailable: await secretAvailable(config),
  });
}

async function runCoreService(): Promise<void> {
  const runtime = await createLocalinkRuntime();
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  try {
    server = await startHttpServer({
      ...httpOptionsFromEnv(process.env),
      runtime,
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();
  await runtime.close();
}

async function runTunnelService(): Promise<void> {
  const config = await readTunnelServiceConfig(stateRoot());
  if (config === undefined)
    throw new Error('Tunnel service is not configured.');
  const binary = await discoverTunnelClient({
    ...(config.tunnelClientPath === undefined
      ? {}
      : { explicitPath: config.tunnelClientPath }),
  });
  if (binary.binaryPath === undefined || binary.compatibility === 'unsupported')
    throw new Error('Supported tunnel-client is unavailable.');
  const result = await runTunnelWrapper(
    {
      binaryPath: binary.binaryPath,
      profileName: config.profileName,
      profileDirectory: new TunnelProfileStore(stateRoot()).profileDirectory,
      workingDirectory: installationContext().runtimePath,
      secretRef: config.secretRef,
      baseEnvironment: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    },
    keychainProvider(),
    new SystemTunnelChildLauncher(),
  );
  process.exitCode = result.exitCode ?? 1;
}

async function recoveryOnce(): Promise<void> {
  const context = installationContext();
  const controller = new LocalServiceController(context);
  const decision = await executeRecoveryOnce({
    stateRoot: context.stateRoot,
    collect: async () => {
      const inspection = await inspectLive();
      return {
        core: inspection.core,
        localMcpReadiness: inspection.localMcp.readiness,
        tunnel: inspection.tunnelService,
        tunnelConnected: inspection.tunnel.status.tunnel.connected,
        tunnelReady: inspection.tunnel.status.tunnel.ready,
        tunnelAuth: inspection.tunnel.status.controlPlaneAuth,
        coreConfig: 'valid' as const,
        tunnelConfig: inspection.tunnel.configState,
        tunnelSecret: inspection.tunnel.secretAvailable
          ? ('available' as const)
          : ('missing' as const),
      };
    },
    mutate: async (serviceId, action) => {
      if (action === 'restart') await controller.restart(serviceId);
      else if (action === 'start') await controller.start(serviceId);
      else throw new Error('Automatic recovery stop is forbidden.');
    },
    writeSnapshot: async (currentDecision) => {
      await writeCurrentSnapshot(await inspectLive(), currentDecision);
    },
  });
  output({ decision });
}

async function handleM5(args: readonly string[]): Promise<boolean> {
  if (args.length === 1 && args[0] === 'doctor') {
    await doctor();
    return true;
  }
  if (args.length === 3 && args[0] === 'tunnel' && args[1] === 'configure') {
    await configureTunnel(args[2]!);
    return true;
  }
  if (args.length === 2 && args[0] === 'tunnel' && args[1] === 'status') {
    const inspection = await inspectLive();
    await writeCurrentSnapshot(inspection);
    output({ tunnel: snapshotFromInspection(inspection).tunnel });
    return true;
  }
  if (args[0] !== 'service') return false;
  if (args.length === 2 && args[1] === 'core-run') {
    await runCoreService();
    return true;
  }
  if (args.length === 2 && args[1] === 'tunnel-run') {
    await runTunnelService();
    return true;
  }
  if (args.length === 3 && args[1] === 'recovery-run' && args[2] === '--once') {
    await recoveryOnce();
    return true;
  }
  const controller = new LocalServiceController(installationContext());
  if (args.length === 2 && args[1] === 'bootstrap') {
    const config = await readTunnelServiceConfig(stateRoot()).catch(
      () => undefined,
    );
    const binary = await discoverTunnelClient({
      ...(config?.tunnelClientPath === undefined
        ? {}
        : { explicitPath: config.tunnelClientPath }),
    });
    const tunnelReady =
      config !== undefined &&
      (await secretAvailable(config)) &&
      binary.available &&
      binary.compatibility !== 'unsupported';
    output(await controller.bootstrap(tunnelReady));
    return true;
  }
  if (args.length === 2 && args[1] === 'bootout') {
    output(await controller.bootout());
    return true;
  }
  if (args.length === 2 && args[1] === 'status') {
    const inspection = await inspectLive();
    output({ service: await writeCurrentSnapshot(inspection) });
    return true;
  }
  if (
    args.length === 3 &&
    args[1] === 'restart' &&
    (args[2] === 'core' || args[2] === 'tunnel')
  ) {
    await controller.restart(
      args[2] === 'core' ? 'localink-core' : 'localink-tunnel',
    );
    output({ restarted: args[2] });
    return true;
  }
  throw new LocalinkError(
    'INVALID_ARGUMENT',
    'Usage: localink service status|bootstrap|bootout --json | localink service restart <core|tunnel> --json | localink service core-run | localink service tunnel-run | localink service recovery-run --once',
  );
}

async function selfTest(): Promise<void> {
  const fixture = await mkdtemp(path.join(tmpdir(), 'localink-self-test-'));
  try {
    const workspaceRoot = path.join(fixture, 'workspace');
    const stateRoot = path.join(fixture, 'state-root');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspaceRoot);
    const workspaces = new WorkspaceRegistry();
    const workspace = await workspaces.register('self-test', workspaceRoot);
    const files = new FilesService(workspaces, createStatePaths(stateRoot));
    const created = await files.createText(
      workspace.id,
      'hello.txt',
      'hello\n',
    );
    const edited = await files.preciseEdit({
      workspaceId: workspace.id,
      relativePath: 'hello.txt',
      expectedText: 'hello',
      replacementText: 'localink',
      expectedSha256: created.sha256,
      expectedOccurrences: 1,
    });
    const processes = new ProcessManager(workspaces);
    const processReceipt = await processes.exec({
      command: process.execPath,
      args: ['-e', "process.stdout.write('process-ok')"],
      workspaceId: workspace.id,
    });
    output({
      ok: processReceipt.exitCode === 0,
      version: LOCALINK_VERSION,
      checks: {
        workspace: workspace.id.length > 0,
        files: edited.occurrences === 1,
        process: processReceipt.stdout.text === 'process-ok',
      },
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv
    .slice(2)
    .filter((argument) => argument !== '--json');
  if (args.length === 2 && args[0] === 'core' && args[1] === 'self-test') {
    await selfTest();
    return;
  }
  if (await handleM5(args)) return;

  const runtime = await createLocalinkRuntime();
  try {
    if (args.length === 2 && args[0] === 'runtime' && args[1] === 'health') {
      output(await runtime.health());
      return;
    }
    if (
      args.length === 4 &&
      args[0] === 'workspace' &&
      args[1] === 'add' &&
      args[2] !== undefined &&
      args[3] !== undefined
    ) {
      output(await runtime.addWorkspace(args[2], args[3]));
      return;
    }
    if (args.length === 2 && args[0] === 'workspace' && args[1] === 'list') {
      output({ workspaces: runtime.workspaces.list() });
      return;
    }
    if (args.length === 2 && args[0] === 'process' && args[1] === 'policy') {
      output({ policy: runtime.processPolicy() });
      return;
    }
    if (args.length === 2 && args[0] === 'process' && args[1] === 'enable') {
      output({
        policy: await runtime.setProcessEnabled(true),
        warning: {
          hostProcessExecution: true,
          shell: false,
          workspaceCwdIsOsSandbox: false,
          commandMayAccessOutsideWorkspace: true,
          message:
            'Enables host process execution. shell remains false, but workspace cwd restriction is not an OS sandbox and commands may access resources outside the workspace.',
        },
      });
      return;
    }
    if (args.length === 2 && args[0] === 'process' && args[1] === 'disable') {
      output({ policy: await runtime.setProcessEnabled(false) });
      return;
    }
    if (args.length === 2 && args[0] === 'skill-source' && args[1] === 'list') {
      output({ sources: await runtime.skillSources() });
      return;
    }
    if (
      args.length === 4 &&
      args[0] === 'skill-source' &&
      args[1] === 'add' &&
      args[2] !== undefined &&
      args[3] !== undefined
    ) {
      output(await runtime.addSkillSource(args[2], args[3]));
      return;
    }
    if (
      args.length === 3 &&
      args[0] === 'skill-source' &&
      args[1] === 'remove' &&
      args[2] !== undefined
    ) {
      output(await runtime.removeSkillSource(args[2]));
      return;
    }
    if (args.length === 2 && args[0] === 'mcp-provider' && args[1] === 'list') {
      output({ providers: await runtime.externalMcpProviders() });
      return;
    }
    if (
      args.length === 4 &&
      args[0] === 'mcp-provider' &&
      args[1] === 'add-http' &&
      args[2] !== undefined &&
      args[3] !== undefined
    ) {
      output(await runtime.addHttpProvider(args[2], args[3]));
      return;
    }
    if (
      args.length >= 4 &&
      args[0] === 'mcp-provider' &&
      args[1] === 'add-stdio' &&
      args[2] !== undefined &&
      args[3] !== undefined
    ) {
      output(await runtime.addStdioProvider(args[2], args[3], args.slice(4)));
      return;
    }
    if (
      args.length === 3 &&
      args[0] === 'mcp-provider' &&
      args[1] === 'remove' &&
      args[2] !== undefined
    ) {
      output(await runtime.removeExternalMcpProvider(args[2]));
      return;
    }
    if (
      args.length === 3 &&
      args[0] === 'workspace' &&
      args[1] === 'inspect' &&
      args[2] !== undefined
    ) {
      output(runtime.workspaces.inspect(args[2]));
      return;
    }
    if (
      args.length === 3 &&
      args[0] === 'workspace' &&
      args[1] === 'remove' &&
      args[2] !== undefined
    ) {
      output(await runtime.removeWorkspace(args[2]));
      return;
    }
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      'Usage: localink doctor --json | localink service status|bootstrap|bootout --json | localink service restart <core|tunnel> --json | localink tunnel configure <tunnel-id> --json | localink tunnel status --json | localink core self-test --json | runtime health --json | workspace add <name> <absolute-root> --json | workspace list --json | workspace inspect <id> --json | workspace remove <id> --json | process policy --json | process enable --json | process disable --json | skill-source list --json | skill-source add <id> <absolute-root> --json | skill-source remove <id> --json | mcp-provider list --json | mcp-provider add-http <id> <loopback-url> --json | mcp-provider add-stdio <id> <absolute-command> [args...] --json | mcp-provider remove <id> --json',
    );
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof LocalinkError) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error.toJSON() })}\n`,
    );
  } else {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: 'IO_ERROR', message: String(error) } })}\n`,
    );
  }
  process.exitCode = 1;
});
