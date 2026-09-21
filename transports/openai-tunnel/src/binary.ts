import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { buildVersionCommand } from './commands.js';
import { TunnelAdapterError } from './errors.js';
import {
  TESTED_LOCAL_TUNNEL_CLIENT_VERSION,
  type Compatibility,
  type TunnelBinaryStatus,
  type TunnelCommand,
} from './types.js';

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;

export interface ParsedTunnelVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface BinaryDiscoveryOptions {
  readonly explicitPath?: string;
  readonly pathValue?: string;
  readonly binaryName?: string;
  readonly timeoutMs?: number;
}

export function parseTunnelVersion(output: string): ParsedTunnelVersion {
  const firstLine = output.trim().split(/\r?\n/u)[0]?.trim() ?? '';
  const raw = firstLine.split(/\s+/u)[0] ?? '';
  const match = VERSION_PATTERN.exec(raw);
  if (match === null) {
    throw new TunnelAdapterError(
      'VERSION_MALFORMED',
      'Tunnel client returned an unrecognized version.',
    );
  }
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function classifyTunnelVersion(
  version: ParsedTunnelVersion,
): Compatibility {
  if (version.raw === TESTED_LOCAL_TUNNEL_CLIENT_VERSION) return 'tested';
  return 'unsupported';
}

function unsupportedVersionReason(version: ParsedTunnelVersion): string {
  if (version.major === 0 && version.minor === 0 && version.patch === 11) {
    return 'TUNNEL_VERSION_MCP_PROTOCOL_INCOMPATIBLE';
  }
  return 'TUNNEL_VERSION_UNVALIDATED';
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findTunnelClientPath(
  options: BinaryDiscoveryOptions = {},
): Promise<string | undefined> {
  if (options.explicitPath !== undefined) {
    const candidate = path.resolve(options.explicitPath);
    return (await executable(candidate)) ? candidate : undefined;
  }
  const binaryName = options.binaryName ?? 'tunnel-client';
  if (binaryName.includes(path.sep) || binaryName.includes('\0'))
    return undefined;
  for (const directory of (options.pathValue ?? process.env.PATH ?? '').split(
    path.delimiter,
  )) {
    if (directory === '') continue;
    const candidate = path.resolve(directory, binaryName);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

export function executeShortLivedCommand(
  command: TunnelCommand,
  timeoutMs = 5_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command.command,
      [...command.args],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          LANG: 'C',
          LC_ALL: 'C',
          ...command.environmentOverrides,
        },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new TunnelAdapterError(
              'BINARY_PROBE_FAILED',
              'Tunnel client probe failed.',
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function discoverTunnelClient(
  options: BinaryDiscoveryOptions = {},
): Promise<TunnelBinaryStatus> {
  const binaryPath = await findTunnelClientPath(options);
  if (binaryPath === undefined) {
    return {
      available: false,
      compatibility: 'unknown',
      reasonCodes: ['TUNNEL_BINARY_MISSING'],
      installRequirement: {
        required: true,
        reasonCode: 'TUNNEL_BINARY_MISSING',
        automaticInstallSupported: false,
      },
    };
  }
  try {
    const { stdout } = await executeShortLivedCommand(
      buildVersionCommand(binaryPath),
      options.timeoutMs,
    );
    const version = parseTunnelVersion(stdout);
    const compatibility = classifyTunnelVersion(version);
    const supported = compatibility === 'tested';
    return {
      available: true,
      binaryPath,
      version: version.raw,
      compatibility,
      reasonCodes: supported
        ? ['TUNNEL_BINARY_PRESENT']
        : ['TUNNEL_VERSION_UNSUPPORTED', unsupportedVersionReason(version)],
      installRequirement: {
        required: !supported,
        reasonCode: supported
          ? 'TUNNEL_BINARY_PRESENT'
          : 'TUNNEL_VERSION_UNSUPPORTED',
        automaticInstallSupported: false,
      },
    };
  } catch (error) {
    const reasonCode =
      error instanceof TunnelAdapterError && error.code === 'VERSION_MALFORMED'
        ? 'TUNNEL_VERSION_MALFORMED'
        : 'TUNNEL_BINARY_PROBE_FAILED';
    return {
      available: true,
      binaryPath,
      compatibility: 'unsupported',
      reasonCodes: [reasonCode],
      installRequirement: {
        required: true,
        reasonCode: 'TUNNEL_BINARY_UNUSABLE',
        automaticInstallSupported: false,
      },
    };
  }
}
