import path from 'node:path';
import { ServiceFoundationError } from './errors.js';
import type { InstallationContext, InstallationContextInput } from './types.js';

const PATH_FIELDS: readonly (keyof Omit<InstallationContextInput, 'uid'>)[] = [
  'installPrefix',
  'localinkExecutablePath',
  'runtimePath',
  'stateRoot',
  'configRoot',
  'logRoot',
  'userHome',
  'launchAgentsDirectory',
];

function invalid(message: string): never {
  throw new ServiceFoundationError('INSTALLATION_CONTEXT_INVALID', message);
}

export function createInstallationContext(
  input: InstallationContextInput,
): InstallationContext {
  const resolved = {} as Record<
    keyof Omit<InstallationContextInput, 'uid'>,
    string
  >;
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (!path.isAbsolute(value) || value.includes('\0')) {
      invalid(`${field} must be an absolute path.`);
    }
    resolved[field] = path.normalize(value);
  }
  if (!Number.isInteger(input.uid) || input.uid <= 0) {
    invalid('uid must identify a non-root user.');
  }
  const expectedLaunchAgentsDirectory = path.join(
    resolved.userHome,
    'Library',
    'LaunchAgents',
  );
  if (resolved.launchAgentsDirectory !== expectedLaunchAgentsDirectory) {
    invalid('LaunchAgents directory must be inside the injected user home.');
  }
  return {
    ...resolved,
    uid: input.uid,
    launchdDomain: `gui/${input.uid}`,
  };
}
