import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildBootoutCommand,
  buildBootstrapCommand,
  buildKickstartCommand,
  buildPrintCommand,
} from './launchctl.js';
import { createLaunchAgentArtifacts, SERVICE_LABELS } from './definitions.js';
import type {
  InstallationContext,
  LaunchctlCommand,
  RecoverableServiceId,
  ServiceId,
  ServiceReadiness,
  ServiceStatus,
} from './types.js';

const MANAGED_MARKER = '<!-- Managed by Localink -->';
const OUTPUT_LIMIT = 1024 * 1024;

export interface FixedCommandExecutor {
  execute(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export class SystemFixedCommandExecutor implements FixedCommandExecutor {
  execute(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          timeout: 10_000,
          maxBuffer: OUTPUT_LIMIT,
          windowsHide: true,
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        },
        (error, stdout, stderr) => {
          if (error === null) resolve({ stdout, stderr });
          else reject(error);
        },
      );
    });
  }
}

export interface LaunchctlPrintStatus {
  readonly installed: boolean;
  readonly processRunning: boolean;
  readonly pid?: number;
  readonly reasonCodes: readonly string[];
}

function parsePrintOutput(output: string): LaunchctlPrintStatus {
  const state = /^\s*state\s*=\s*([a-z]+)\s*$/imu.exec(output)?.[1];
  const rawPid = /^\s*pid\s*=\s*(\d+)\s*$/imu.exec(output)?.[1];
  const pid = rawPid === undefined ? undefined : Number(rawPid);
  const running = state === 'running' && Number.isInteger(pid) && pid! > 0;
  return {
    installed: true,
    processRunning: running,
    ...(running ? { pid: pid! } : {}),
    reasonCodes: running ? [] : ['SERVICE_NOT_RUNNING'],
  };
}

export class LaunchctlExecutor {
  readonly #executor: FixedCommandExecutor;

  constructor(
    executor: FixedCommandExecutor = new SystemFixedCommandExecutor(),
  ) {
    this.#executor = executor;
  }

  async execute(command: LaunchctlCommand): Promise<void> {
    if (command.command !== '/bin/launchctl')
      throw new Error('Unsafe launchctl command.');
    try {
      await this.#executor.execute(command.command, command.args);
    } catch {
      throw new Error('launchctl operation failed.');
    }
  }

  async print(command: LaunchctlCommand): Promise<LaunchctlPrintStatus> {
    if (command.command !== '/bin/launchctl' || command.args[0] !== 'print')
      throw new Error('Unsafe launchctl status command.');
    try {
      const result = await this.#executor.execute(
        command.command,
        command.args,
      );
      return parsePrintOutput(result.stdout);
    } catch {
      return {
        installed: false,
        processRunning: false,
        reasonCodes: ['SERVICE_NOT_INSTALLED'],
      };
    }
  }

  async domainLabels(domain: string): Promise<readonly string[]> {
    if (!/^gui\/\d+$/u.test(domain)) throw new Error('Unsafe launchd domain.');
    try {
      const result = await this.#executor.execute('/bin/launchctl', [
        'print',
        domain,
      ]);
      return [
        ...new Set(result.stdout.match(/com\.localink\.[a-z0-9.-]+/gu) ?? []),
      ];
    } catch {
      throw new Error('Unable to inspect launchd domain.');
    }
  }
}

async function atomicManagedWrite(
  destination: string,
  contents: string,
): Promise<'created' | 'unchanged' | 'replaced'> {
  let existing: string | undefined;
  try {
    existing = await readFile(destination, 'utf8');
  } catch (error) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ))
      throw error;
  }
  if (existing === contents) return 'unchanged';
  if (existing !== undefined && !existing.includes(MANAGED_MARKER))
    throw new Error('Existing LaunchAgent is not owned by Localink.');
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (existing !== undefined) {
    await copyFile(destination, `${destination}.backup-${Date.now()}`);
  }
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return existing === undefined ? 'created' : 'replaced';
}

export interface ServiceBootstrapReceipt {
  readonly bootstrapped: readonly ServiceId[];
  readonly skipped: readonly ServiceId[];
  readonly requiresRoot: false;
}

export class LocalServiceController {
  readonly #context: InstallationContext;
  readonly #launchctl: LaunchctlExecutor;
  readonly #executor: FixedCommandExecutor;
  readonly #currentUid: () => number;

  constructor(
    context: InstallationContext,
    launchctl = new LaunchctlExecutor(),
    executor: FixedCommandExecutor = new SystemFixedCommandExecutor(),
    currentUid: () => number = () => process.getuid?.() ?? 0,
  ) {
    this.#context = context;
    this.#launchctl = launchctl;
    this.#executor = executor;
    this.#currentUid = currentUid;
  }

  async preflight(): Promise<void> {
    if (this.#currentUid() === 0 || this.#currentUid() !== this.#context.uid)
      throw new Error('Root execution is forbidden.');
    await Promise.all([
      access(this.#context.localinkExecutablePath, constants.X_OK),
      access(this.#context.runtimePath, constants.R_OK),
    ]).catch(() => {
      throw new Error('Current checkout service entrypoint is unavailable.');
    });
    const known = new Set(Object.values(SERVICE_LABELS));
    const loaded = await this.#launchctl.domainLabels(
      this.#context.launchdDomain,
    );
    if (loaded.some((label) => !known.has(label)))
      throw new Error('Unknown com.localink service is already registered.');
    let files: string[] = [];
    try {
      files = await readdir(this.#context.launchAgentsDirectory);
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    const unknown = files.filter(
      (name) =>
        /^com\.localink\..+\.plist$/u.test(name) &&
        !known.has(name.slice(0, -'.plist'.length)),
    );
    if (unknown.length > 0)
      throw new Error('Unknown com.localink LaunchAgent artifact exists.');
    for (const label of known) {
      const destination = path.join(
        this.#context.launchAgentsDirectory,
        `${label}.plist`,
      );
      try {
        const source = await readFile(destination, 'utf8');
        if (!source.includes(MANAGED_MARKER))
          throw new Error('Existing Localink label is not a managed artifact.');
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          const status = await this.#launchctl.print(
            buildPrintCommand(this.#context, label),
          );
          if (status.installed)
            throw new Error(
              'Existing Localink service has no managed artifact.',
            );
          continue;
        }
        throw error;
      }
    }
  }

  async bootstrap(tunnelReady: boolean): Promise<ServiceBootstrapReceipt> {
    await this.preflight();
    await Promise.all([
      mkdir(this.#context.stateRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#context.configRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#context.logRoot, { recursive: true, mode: 0o700 }),
    ]);
    const selected = new Set<ServiceId>([
      'localink-core',
      'localink-recovery',
      ...(tunnelReady ? (['localink-tunnel'] as const) : []),
    ]);
    const bootstrapped: ServiceId[] = [];
    const skipped: ServiceId[] = [];
    for (const artifact of createLaunchAgentArtifacts(this.#context)) {
      if (!selected.has(artifact.serviceId)) {
        skipped.push(artifact.serviceId);
        continue;
      }
      const writeResult = await atomicManagedWrite(
        artifact.destinationPath,
        artifact.contents,
      );
      await this.#executor.execute('/usr/bin/plutil', [
        '-lint',
        artifact.destinationPath,
      ]);
      const status = await this.#launchctl.print(
        buildPrintCommand(this.#context, artifact.label),
      );
      if (status.installed && writeResult === 'replaced') {
        await this.#launchctl.execute(
          buildBootoutCommand(this.#context, artifact.label),
        );
      }
      if (!status.installed || writeResult === 'replaced')
        await this.#launchctl.execute(
          buildBootstrapCommand(this.#context, artifact),
        );
      bootstrapped.push(artifact.serviceId);
    }
    return { bootstrapped, skipped, requiresRoot: false };
  }

  async rebootstrap(tunnelReady: boolean): Promise<ServiceBootstrapReceipt> {
    await this.preflight();
    await Promise.all([
      mkdir(this.#context.stateRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#context.configRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#context.logRoot, { recursive: true, mode: 0o700 }),
    ]);
    const selected = new Set<ServiceId>([
      'localink-core',
      'localink-recovery',
      ...(tunnelReady ? (['localink-tunnel'] as const) : []),
    ]);
    const artifacts = createLaunchAgentArtifacts(this.#context);
    for (const artifact of artifacts) {
      if (!selected.has(artifact.serviceId)) continue;
      await atomicManagedWrite(artifact.destinationPath, artifact.contents);
      await this.#executor.execute('/usr/bin/plutil', [
        '-lint',
        artifact.destinationPath,
      ]);
    }
    for (const serviceId of [
      'localink-recovery',
      'localink-tunnel',
      'localink-core',
    ] as const) {
      const label = SERVICE_LABELS[serviceId];
      const status = await this.#launchctl.print(
        buildPrintCommand(this.#context, label),
      );
      if (status.installed) {
        await this.#launchctl.execute(
          buildBootoutCommand(this.#context, label),
        );
      }
    }
    const bootstrapped: ServiceId[] = [];
    const skipped: ServiceId[] = [];
    for (const artifact of artifacts) {
      if (!selected.has(artifact.serviceId)) {
        skipped.push(artifact.serviceId);
        continue;
      }
      await this.#launchctl.execute(
        buildBootstrapCommand(this.#context, artifact),
      );
      bootstrapped.push(artifact.serviceId);
    }
    return { bootstrapped, skipped, requiresRoot: false };
  }

  async bootout(): Promise<{ readonly bootedOut: readonly ServiceId[] }> {
    const bootedOut: ServiceId[] = [];
    for (const serviceId of [
      'localink-recovery',
      'localink-tunnel',
      'localink-core',
    ] as const) {
      const label = SERVICE_LABELS[serviceId];
      const status = await this.#launchctl.print(
        buildPrintCommand(this.#context, label),
      );
      if (!status.installed) continue;
      await this.#launchctl.execute(buildBootoutCommand(this.#context, label));
      bootedOut.push(serviceId);
    }
    return { bootedOut };
  }

  async restart(serviceId: RecoverableServiceId): Promise<void> {
    await this.#launchctl.execute(
      buildKickstartCommand(this.#context, SERVICE_LABELS[serviceId], true),
    );
  }

  async start(serviceId: RecoverableServiceId): Promise<void> {
    await this.#launchctl.execute(
      buildKickstartCommand(this.#context, SERVICE_LABELS[serviceId]),
    );
  }

  async status(
    serviceId: ServiceId,
    readiness: ServiceReadiness = 'unknown',
    checkedAt = new Date().toISOString(),
  ): Promise<ServiceStatus> {
    const printed = await this.#launchctl.print(
      buildPrintCommand(this.#context, SERVICE_LABELS[serviceId]),
    );
    return {
      serviceId,
      installed: printed.installed,
      processRunning: printed.processRunning,
      ...(printed.pid === undefined ? {} : { pid: printed.pid }),
      readiness,
      recentRestarts: 0,
      reasonCodes: printed.reasonCodes,
      checkedAt,
    };
  }
}
