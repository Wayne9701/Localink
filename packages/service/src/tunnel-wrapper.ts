import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { SecretProvider } from '@localink/sdk';
import {
  CONTROL_PLANE_API_KEY_ENV,
  buildRunCommand,
  resolveTunnelSecretEnvironment,
} from '@localink/openai-tunnel';
import { ServiceFoundationError } from './errors.js';
import type { TunnelLaunchReceipt, TunnelWrapperInput } from './types.js';

export interface TunnelChildLauncher {
  launch(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly shell: false;
    },
  ): Promise<TunnelOwnedChild>;
}

export interface TunnelOwnedChild {
  readonly pid?: number;
  wait(): Promise<{
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  signal(signal: NodeJS.Signals): boolean;
}

export class SystemTunnelChildLauncher implements TunnelChildLauncher {
  async launch(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly shell: false;
    },
  ): Promise<TunnelOwnedChild> {
    const child = spawn(command, [...args], {
      ...options,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await Promise.race([
      once(child, 'spawn'),
      once(child, 'error').then(([error]) => Promise.reject(error)),
    ]);
    return ownedChild(child);
  }
}

function ownedChild(child: ChildProcess): TunnelOwnedChild {
  let waiting:
    | Promise<{
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
      }>
    | undefined;
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    wait() {
      waiting ??= new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
      });
      return waiting;
    },
    signal(signal) {
      return child.kill(signal);
    },
  };
}

export async function runTunnelWrapper(
  input: TunnelWrapperInput,
  provider: SecretProvider,
  launcher: TunnelChildLauncher,
  options: {
    readonly signalEmitter?: NodeJS.Process;
    readonly shutdownMs?: number;
  } = {},
): Promise<TunnelLaunchReceipt> {
  if (!path.isAbsolute(input.workingDirectory)) {
    throw new ServiceFoundationError(
      'TUNNEL_LAUNCH_FAILED',
      'Tunnel working directory must be absolute.',
    );
  }
  if (input.baseEnvironment?.[CONTROL_PLANE_API_KEY_ENV] !== undefined) {
    throw new ServiceFoundationError(
      'TUNNEL_LAUNCH_FAILED',
      'Tunnel API key must come from the configured SecretProvider.',
    );
  }
  const command = buildRunCommand(
    input.binaryPath,
    input.profileName,
    input.profileDirectory,
  );
  let secretEnvironment;
  try {
    secretEnvironment = await resolveTunnelSecretEnvironment(
      provider,
      input.secretRef,
    );
  } catch {
    throw new ServiceFoundationError(
      'TUNNEL_SECRET_UNAVAILABLE',
      'Tunnel runtime credential is unavailable.',
    );
  }
  let launched: TunnelOwnedChild;
  try {
    launched = await launcher.launch(command.command, command.args, {
      cwd: input.workingDirectory,
      env: secretEnvironment.forSpawn({
        ...input.baseEnvironment,
        ...command.environmentOverrides,
      }),
      shell: false,
    });
  } catch {
    throw new ServiceFoundationError(
      'TUNNEL_LAUNCH_FAILED',
      'Tunnel child process could not be launched.',
    );
  }
  const emitter = options.signalEmitter ?? process;
  let forcedTimer: NodeJS.Timeout | undefined;
  const forward = (signal: NodeJS.Signals) => {
    launched.signal(signal);
    forcedTimer ??= setTimeout(
      () => launched.signal('SIGKILL'),
      options.shutdownMs ?? 5_000,
    );
    forcedTimer.unref();
  };
  const sigterm = () => forward('SIGTERM');
  const sigint = () => forward('SIGINT');
  emitter.once('SIGTERM', sigterm);
  emitter.once('SIGINT', sigint);
  let exited: Awaited<ReturnType<TunnelOwnedChild['wait']>>;
  try {
    exited = await launched.wait();
  } finally {
    if (forcedTimer !== undefined) clearTimeout(forcedTimer);
    emitter.removeListener('SIGTERM', sigterm);
    emitter.removeListener('SIGINT', sigint);
  }
  return {
    serviceId: 'localink-tunnel',
    launched: true,
    ...(launched.pid === undefined ? {} : { pid: launched.pid }),
    command: command.command,
    args: command.args,
    secretInjected: true,
    injectedEnvironmentKeys: [CONTROL_PLANE_API_KEY_ENV],
    exitCode: exited.exitCode,
    signal: exited.signal,
  };
}
