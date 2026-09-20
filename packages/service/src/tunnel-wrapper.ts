import path from 'node:path';
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
  ): Promise<{ readonly pid?: number }>;
}

export async function runTunnelWrapper(
  input: TunnelWrapperInput,
  provider: SecretProvider,
  launcher: TunnelChildLauncher,
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
  let launched: { readonly pid?: number };
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
  return {
    serviceId: 'localink-tunnel',
    launched: true,
    ...(launched.pid === undefined ? {} : { pid: launched.pid }),
    command: command.command,
    args: command.args,
    secretInjected: true,
    injectedEnvironmentKeys: [CONTROL_PLANE_API_KEY_ENV],
  };
}
