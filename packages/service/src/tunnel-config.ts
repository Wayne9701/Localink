import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { SecretRef } from '@localink/sdk';
import { validateTunnelProfile } from '@localink/openai-tunnel';

export const TUNNEL_SERVICE_CONFIG_VERSION = 1 as const;
export const LOCALINK_TUNNEL_PROFILE = 'localink' as const;
export const LOCALINK_TUNNEL_SECRET_REF: SecretRef = Object.freeze({
  provider: 'macos-keychain',
  namespace: 'openai-tunnel',
  key: 'runtime-api-key',
});

export interface TunnelServiceConfig {
  readonly version: typeof TUNNEL_SERVICE_CONFIG_VERSION;
  readonly profileName: typeof LOCALINK_TUNNEL_PROFILE;
  readonly tunnelId: string;
  readonly localMcpUrl: 'http://127.0.0.1:4318/mcp';
  readonly healthListenAddress: string;
  readonly secretRef: typeof LOCALINK_TUNNEL_SECRET_REF;
  readonly tunnelClientPath?: string;
}

export function tunnelServiceConfigPath(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'config', 'tunnel-service.json');
}

export function validateTunnelServiceConfig(
  value: unknown,
): TunnelServiceConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Tunnel service config must be an object.');
  const config = value as Record<string, unknown>;
  const allowed = new Set([
    'version',
    'profileName',
    'tunnelId',
    'localMcpUrl',
    'healthListenAddress',
    'secretRef',
    'tunnelClientPath',
  ]);
  if (Object.keys(config).some((key) => !allowed.has(key)))
    throw new Error('Tunnel service config contains unknown fields.');
  const secret = config.secretRef;
  if (
    config.version !== TUNNEL_SERVICE_CONFIG_VERSION ||
    config.profileName !== LOCALINK_TUNNEL_PROFILE ||
    config.localMcpUrl !== 'http://127.0.0.1:4318/mcp' ||
    typeof config.tunnelId !== 'string' ||
    typeof config.healthListenAddress !== 'string' ||
    typeof secret !== 'object' ||
    secret === null ||
    Array.isArray(secret) ||
    (secret as Record<string, unknown>).provider !== 'macos-keychain' ||
    (secret as Record<string, unknown>).namespace !== 'openai-tunnel' ||
    (secret as Record<string, unknown>).key !== 'runtime-api-key' ||
    (config.tunnelClientPath !== undefined &&
      (typeof config.tunnelClientPath !== 'string' ||
        !path.isAbsolute(config.tunnelClientPath) ||
        config.tunnelClientPath.includes('\0')))
  ) {
    throw new Error('Tunnel service config is invalid.');
  }
  validateTunnelProfile({
    name: LOCALINK_TUNNEL_PROFILE,
    tunnelId: config.tunnelId,
    apiKeySecretRef: LOCALINK_TUNNEL_SECRET_REF,
    localMcpUrl: 'http://127.0.0.1:4318/mcp',
    healthListenAddress: config.healthListenAddress,
  });
  return {
    version: TUNNEL_SERVICE_CONFIG_VERSION,
    profileName: LOCALINK_TUNNEL_PROFILE,
    tunnelId: config.tunnelId,
    localMcpUrl: 'http://127.0.0.1:4318/mcp',
    healthListenAddress: config.healthListenAddress,
    secretRef: LOCALINK_TUNNEL_SECRET_REF,
    ...(config.tunnelClientPath === undefined
      ? {}
      : { tunnelClientPath: config.tunnelClientPath }),
  };
}

export async function readTunnelServiceConfig(
  stateRoot: string,
): Promise<TunnelServiceConfig | undefined> {
  let source: string;
  try {
    source = await readFile(tunnelServiceConfigPath(stateRoot), 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined;
    throw new Error('Unable to read tunnel service config.');
  }
  try {
    return validateTunnelServiceConfig(JSON.parse(source) as unknown);
  } catch {
    throw new Error('Tunnel service config is invalid.');
  }
}

export async function writeTunnelServiceConfig(
  stateRoot: string,
  value: TunnelServiceConfig,
): Promise<TunnelServiceConfig> {
  const config = validateTunnelServiceConfig(value);
  const destination = tunnelServiceConfigPath(stateRoot);
  const temporary = path.join(
    path.dirname(destination),
    `.tunnel-service.${randomUUID()}.tmp`,
  );
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new Error('Unable to atomically write tunnel service config.');
  }
  return config;
}

export function createTunnelServiceConfig(
  tunnelId: string,
  options: {
    readonly healthListenAddress?: string;
    readonly tunnelClientPath?: string;
  } = {},
): TunnelServiceConfig {
  return validateTunnelServiceConfig({
    version: TUNNEL_SERVICE_CONFIG_VERSION,
    profileName: LOCALINK_TUNNEL_PROFILE,
    tunnelId,
    localMcpUrl: 'http://127.0.0.1:4318/mcp',
    healthListenAddress: options.healthListenAddress ?? '127.0.0.1:4319',
    secretRef: LOCALINK_TUNNEL_SECRET_REF,
    ...(options.tunnelClientPath === undefined
      ? {}
      : { tunnelClientPath: options.tunnelClientPath }),
  });
}
