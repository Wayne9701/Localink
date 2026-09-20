import { createLaunchAgentArtifacts, SERVICE_LABELS } from './definitions.js';
import { serviceTarget } from './launchctl.js';
import type {
  InstallPlan,
  InstallationContext,
  UninstallPlan,
} from './types.js';

export function createInstallPlan(context: InstallationContext): InstallPlan {
  return {
    domainTarget: context.launchdDomain,
    artifacts: createLaunchAgentArtifacts(context),
    requiredPermissions: ['user_launch_agent_write'],
    requiresRoot: false,
  };
}

export function createUninstallPlan(
  context: InstallationContext,
): UninstallPlan {
  const artifacts = createLaunchAgentArtifacts(context);
  return {
    serviceTargets: artifacts.map((artifact) =>
      serviceTarget(context, SERVICE_LABELS[artifact.serviceId]),
    ),
    plistPaths: artifacts.map((artifact) => artifact.destinationPath),
    preservePaths: [context.stateRoot, context.configRoot, context.logRoot],
    preservesUserData: true,
    preservesSecrets: true,
    requiresRoot: false,
  };
}
