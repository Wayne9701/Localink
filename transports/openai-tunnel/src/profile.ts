import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { createStatePaths } from '@localink/core';
import { TunnelAdapterError } from './errors.js';
import { validateProfileName } from './commands.js';
import {
  CONTROL_PLANE_API_KEY_ENV,
  DEFAULT_CONTROL_PLANE_BASE_URL,
  DEFAULT_HEALTH_LISTEN_ADDRESS,
  type TunnelProfileInput,
  type TunnelProfileWriteReceipt,
  type ValidatedTunnelProfile,
} from './types.js';

function invalid(message: string): never {
  throw new TunnelAdapterError('PROFILE_INVALID', message);
}

function assertTunnelId(tunnelId: string): string {
  if (!/^tunnel_[A-Za-z0-9_-]{8,128}$/u.test(tunnelId)) {
    invalid('Tunnel id must use the official tunnel_ identifier form.');
  }
  return tunnelId;
}

function assertControlPlaneUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid('Control-plane base URL is malformed.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    invalid('Control-plane base URL must be an HTTPS origin.');
  }
  return parsed.origin;
}

function assertLocalMcpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid('Local MCP URL is malformed.');
  }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (
    parsed.protocol !== 'http:' ||
    !loopbackHosts.has(parsed.hostname) ||
    parsed.port === '' ||
    parsed.pathname !== '/mcp' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    invalid('Local MCP URL must be an explicit loopback HTTP /mcp endpoint.');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    invalid('Local MCP URL port is out of range.');
  }
  return parsed.toString();
}

function assertHealthAddress(value: string): string {
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/u.exec(value);
  const port = Number(match?.[2]);
  if (match === null || !Number.isInteger(port) || port < 0 || port > 65_535) {
    invalid('Health address must bind a loopback host and a valid port.');
  }
  return value;
}

function assertHealthUrlFile(value: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    invalid('Health URL file path must be absolute.');
  }
  return path.normalize(value);
}

export function validateTunnelProfile(
  input: TunnelProfileInput,
): ValidatedTunnelProfile {
  if (
    typeof input.apiKeySecretRef !== 'object' ||
    input.apiKeySecretRef === null ||
    input.apiKeySecretRef.provider.trim() === '' ||
    input.apiKeySecretRef.key.trim() === ''
  ) {
    invalid('A valid API key SecretRef is required.');
  }
  const healthUrlFile =
    input.healthUrlFile === undefined
      ? undefined
      : assertHealthUrlFile(input.healthUrlFile);
  return {
    name: validateProfileName(input.name),
    tunnelId: assertTunnelId(input.tunnelId),
    apiKeySecretRef: structuredClone(input.apiKeySecretRef),
    apiKeyEnvironmentReference: `env:${CONTROL_PLANE_API_KEY_ENV}`,
    localMcpUrl: assertLocalMcpUrl(input.localMcpUrl),
    controlPlaneBaseUrl: assertControlPlaneUrl(
      input.controlPlaneBaseUrl ?? DEFAULT_CONTROL_PLANE_BASE_URL,
    ),
    healthListenAddress: assertHealthAddress(
      input.healthListenAddress ?? DEFAULT_HEALTH_LISTEN_ADDRESS,
    ),
    ...(healthUrlFile === undefined ? {} : { healthUrlFile }),
  };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderTunnelProfile(profile: ValidatedTunnelProfile): string {
  return [
    'config_version: 1',
    'control_plane:',
    `  base_url: ${yamlString(profile.controlPlaneBaseUrl)}`,
    `  tunnel_id: ${yamlString(profile.tunnelId)}`,
    `  api_key: ${yamlString(profile.apiKeyEnvironmentReference)}`,
    'health:',
    `  listen_addr: ${yamlString(profile.healthListenAddress)}`,
    ...(profile.healthUrlFile === undefined
      ? []
      : [`  url_file: ${yamlString(profile.healthUrlFile)}`]),
    'admin_ui:',
    '  open_browser: false',
    'log:',
    '  level: info',
    '  format: json',
    'mcp:',
    '  server_urls:',
    '    - channel: main',
    `      url: ${yamlString(profile.localMcpUrl)}`,
    '',
  ].join('\n');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function currentFile(
  profilePath: string,
): Promise<{ readonly source: string; readonly hash: string } | undefined> {
  try {
    const source = await readFile(profilePath, 'utf8');
    return { source, hash: sha256(source) };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw new TunnelAdapterError(
      'PROFILE_IO_FAILED',
      'Unable to read profile.',
    );
  }
}

export class TunnelProfileStore {
  readonly profileDirectory: string;

  constructor(stateRoot?: string) {
    const paths = createStatePaths(stateRoot);
    this.profileDirectory = path.join(
      paths.config,
      'openai-tunnel',
      'profiles',
    );
  }

  profilePath(name: string): string {
    return path.join(
      this.profileDirectory,
      `${validateProfileName(name)}.yaml`,
    );
  }

  async write(
    input: TunnelProfileInput,
    options: { readonly expectedSha256?: string } = {},
  ): Promise<TunnelProfileWriteReceipt> {
    const profile = validateTunnelProfile(input);
    const profilePath = this.profilePath(profile.name);
    const existing = await currentFile(profilePath);
    if (
      options.expectedSha256 !== undefined &&
      existing?.hash !== options.expectedSha256
    ) {
      throw new TunnelAdapterError(
        'PROFILE_STALE',
        'Profile changed since it was last read.',
      );
    }
    const rendered = renderTunnelProfile(profile);
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      this.profileDirectory,
      `.${profile.name}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(rendered, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, profilePath);
      await access(profilePath, constants.R_OK);
    } catch {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new TunnelAdapterError(
        'PROFILE_IO_FAILED',
        'Unable to atomically write profile.',
      );
    }
    return {
      profileName: profile.name,
      profilePath,
      profileDirectory: this.profileDirectory,
      sha256: sha256(rendered),
      replaced: existing !== undefined,
      apiKeySource: `env:${CONTROL_PLANE_API_KEY_ENV}`,
    };
  }
}
