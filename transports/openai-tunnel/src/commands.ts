import path from 'node:path';
import { TunnelAdapterError } from './errors.js';
import type { TunnelCommand } from './types.js';

export function validateProfileName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(name)) {
    throw new TunnelAdapterError(
      'PROFILE_INVALID',
      'Profile name must use lowercase letters, numbers, dash, or underscore.',
    );
  }
  return name;
}

function assertBinaryPath(binaryPath: string): string {
  if (!path.isAbsolute(binaryPath) || binaryPath.includes('\0')) {
    throw new TunnelAdapterError(
      'BINARY_NOT_EXECUTABLE',
      'Tunnel client path must be absolute.',
    );
  }
  return binaryPath;
}

function profileEnvironment(
  profileDirectory: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (profileDirectory === undefined) return undefined;
  if (!path.isAbsolute(profileDirectory) || profileDirectory.includes('\0')) {
    throw new TunnelAdapterError(
      'PROFILE_INVALID',
      'Profile directory must be absolute.',
    );
  }
  return { TUNNEL_CLIENT_PROFILE_DIR: profileDirectory };
}

export function buildVersionCommand(binaryPath: string): TunnelCommand {
  return { command: assertBinaryPath(binaryPath), args: ['--version'] };
}

export function buildQuickstartHelpCommand(binaryPath: string): TunnelCommand {
  return {
    command: assertBinaryPath(binaryPath),
    args: ['help', 'quickstart'],
  };
}

export function buildDoctorCommand(
  binaryPath: string,
  profileName: string,
  options: { readonly profileDirectory?: string; readonly json?: boolean } = {},
): TunnelCommand {
  const args = [
    'doctor',
    '--profile',
    validateProfileName(profileName),
    '--explain',
  ];
  if (options.json === true) args.push('--json');
  const environmentOverrides = profileEnvironment(options.profileDirectory);
  return {
    command: assertBinaryPath(binaryPath),
    args,
    ...(environmentOverrides === undefined ? {} : { environmentOverrides }),
  };
}

export function buildRunCommand(
  binaryPath: string,
  profileName: string,
  profileDirectory: string,
): TunnelCommand {
  const validatedDirectory =
    profileEnvironment(profileDirectory)?.TUNNEL_CLIENT_PROFILE_DIR;
  if (validatedDirectory === undefined) {
    throw new TunnelAdapterError(
      'PROFILE_INVALID',
      'Profile directory is required.',
    );
  }
  return {
    command: assertBinaryPath(binaryPath),
    args: [
      'run',
      '--profile',
      validateProfileName(profileName),
      '--profile-dir',
      validatedDirectory,
    ],
  };
}
