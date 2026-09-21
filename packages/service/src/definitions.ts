import path from 'node:path';
import { ServiceFoundationError } from './errors.js';
import { renderLaunchAgentPlist } from './plist.js';
import type {
  InstallationContext,
  LaunchAgentArtifact,
  LaunchAgentDefinition,
  ServiceId,
} from './types.js';

export const SERVICE_LABELS: Readonly<Record<ServiceId, string>> = {
  'localink-core': 'com.localink.core',
  'localink-tunnel': 'com.localink.tunnel',
  'localink-recovery': 'com.localink.recovery',
};

function definition(
  context: InstallationContext,
  serviceId: ServiceId,
  args: readonly string[],
  startInterval?: number,
): LaunchAgentDefinition {
  const environment = {
    LOCALINK_CONFIG_ROOT: context.configRoot,
    LOCALINK_LOG_ROOT: context.logRoot,
    LOCALINK_STATE_ROOT: context.stateRoot,
  };
  return {
    serviceId,
    Label: SERVICE_LABELS[serviceId],
    ProgramArguments: [
      context.localinkExecutablePath,
      ...context.localinkEntrypointArguments,
      ...args,
    ],
    WorkingDirectory: context.runtimePath,
    RunAtLoad: true,
    KeepAlive: false,
    ...(startInterval === undefined ? {} : { StartInterval: startInterval }),
    StandardOutPath: path.join(context.logRoot, `${serviceId}.stdout.log`),
    StandardErrorPath: path.join(context.logRoot, `${serviceId}.stderr.log`),
    EnvironmentVariables: environment,
    Umask: '077',
  };
}

export function createServiceDefinitions(
  context: InstallationContext,
  options: { readonly recoveryIntervalSeconds?: number } = {},
): readonly LaunchAgentDefinition[] {
  const recoveryIntervalSeconds = options.recoveryIntervalSeconds ?? 60;
  if (
    !Number.isInteger(recoveryIntervalSeconds) ||
    recoveryIntervalSeconds < 30 ||
    recoveryIntervalSeconds > 3600
  ) {
    throw new ServiceFoundationError(
      'PLIST_INVALID',
      'Recovery interval must be between 30 and 3600 seconds.',
    );
  }
  return [
    definition(context, 'localink-core', ['service', 'core-run']),
    definition(context, 'localink-tunnel', ['service', 'tunnel-run']),
    definition(
      context,
      'localink-recovery',
      ['service', 'recovery-run', '--once'],
      recoveryIntervalSeconds,
    ),
  ];
}

export function createLaunchAgentArtifacts(
  context: InstallationContext,
  options: { readonly recoveryIntervalSeconds?: number } = {},
): readonly LaunchAgentArtifact[] {
  return createServiceDefinitions(context, options).map((item) => ({
    serviceId: item.serviceId,
    label: item.Label,
    destinationPath: path.join(
      context.launchAgentsDirectory,
      `${item.Label}.plist`,
    ),
    contents: renderLaunchAgentPlist(item),
  }));
}
