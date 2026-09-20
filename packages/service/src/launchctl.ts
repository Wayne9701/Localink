import path from 'node:path';
import { ServiceFoundationError } from './errors.js';
import type {
  InstallationContext,
  LaunchAgentArtifact,
  LaunchctlCommand,
} from './types.js';

const LAUNCHCTL = '/bin/launchctl' as const;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9.-]{2,127}$/u;

function assertLabel(label: string): string {
  if (!LABEL_PATTERN.test(label)) {
    throw new ServiceFoundationError(
      'LAUNCHCTL_TARGET_INVALID',
      'LaunchAgent label is invalid.',
    );
  }
  return label;
}

function domainTarget(context: InstallationContext): `gui/${number}` {
  if (context.launchdDomain !== `gui/${context.uid}` || context.uid <= 0) {
    throw new ServiceFoundationError(
      'LAUNCHCTL_TARGET_INVALID',
      'Only the injected non-root GUI user domain is supported.',
    );
  }
  return context.launchdDomain;
}

export function serviceTarget(
  context: InstallationContext,
  label: string,
): string {
  return `${domainTarget(context)}/${assertLabel(label)}`;
}

export function buildBootstrapCommand(
  context: InstallationContext,
  artifact: LaunchAgentArtifact,
): LaunchctlCommand {
  const expectedPrefix = `${context.launchAgentsDirectory}${path.sep}`;
  if (
    !path.isAbsolute(artifact.destinationPath) ||
    !path.normalize(artifact.destinationPath).startsWith(expectedPrefix) ||
    artifact.destinationPath !==
      path.join(context.launchAgentsDirectory, `${artifact.label}.plist`)
  ) {
    throw new ServiceFoundationError(
      'LAUNCHCTL_TARGET_INVALID',
      'LaunchAgent artifact is outside the injected user directory.',
    );
  }
  return {
    command: LAUNCHCTL,
    args: ['bootstrap', domainTarget(context), artifact.destinationPath],
  };
}

export function buildBootoutCommand(
  context: InstallationContext,
  label: string,
): LaunchctlCommand {
  return {
    command: LAUNCHCTL,
    args: ['bootout', serviceTarget(context, label)],
  };
}

export function buildKickstartCommand(
  context: InstallationContext,
  label: string,
  restart = false,
): LaunchctlCommand {
  return {
    command: LAUNCHCTL,
    args: [
      'kickstart',
      ...(restart ? ['-k'] : []),
      serviceTarget(context, label),
    ],
  };
}

export function buildPrintCommand(
  context: InstallationContext,
  label: string,
): LaunchctlCommand {
  return {
    command: LAUNCHCTL,
    args: ['print', serviceTarget(context, label)],
  };
}
