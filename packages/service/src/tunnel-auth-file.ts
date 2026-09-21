import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tunnelAuthFilePath } from '@localink/openai-tunnel';

export const LEGACY_TUNNEL_KEYCHAIN_SERVICE = 'localink.openai-tunnel' as const;
export const LEGACY_TUNNEL_KEYCHAIN_ACCOUNT = 'runtime-api-key' as const;

export interface TunnelAuthFileInspection {
  readonly available: boolean;
  readonly reasonCode:
    | 'AUTH_FILE_READY'
    | 'AUTH_FILE_MISSING'
    | 'SECRETS_DIRECTORY_INVALID'
    | 'AUTH_FILE_SYMLINK'
    | 'AUTH_FILE_NOT_REGULAR'
    | 'AUTH_FILE_MODE_INVALID'
    | 'AUTH_FILE_OWNER_INVALID'
    | 'AUTH_FILE_EMPTY';
}

export interface LegacyKeychainReader {
  read(service: string, account: string): Promise<string | undefined>;
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function currentUid(value?: number): number {
  const uid = value ?? process.getuid?.();
  if (uid === undefined || !Number.isInteger(uid) || uid <= 0)
    throw new Error('A non-root current user is required.');
  return uid;
}

function permissions(mode: number): number {
  return mode & 0o777;
}

export async function inspectTunnelAuthFile(
  stateRoot: string,
  uid?: number,
): Promise<TunnelAuthFileInspection> {
  const owner = currentUid(uid);
  const authFile = tunnelAuthFilePath(stateRoot);
  const secretsDirectory = path.dirname(authFile);
  let directory;
  try {
    directory = await lstat(secretsDirectory);
  } catch (error) {
    if (missing(error))
      return { available: false, reasonCode: 'AUTH_FILE_MISSING' };
    throw new Error('Tunnel auth metadata inspection failed.');
  }
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    permissions(directory.mode) !== 0o700 ||
    directory.uid !== owner
  ) {
    return { available: false, reasonCode: 'SECRETS_DIRECTORY_INVALID' };
  }
  let file;
  try {
    file = await lstat(authFile);
  } catch (error) {
    if (missing(error))
      return { available: false, reasonCode: 'AUTH_FILE_MISSING' };
    throw new Error('Tunnel auth metadata inspection failed.');
  }
  if (file.isSymbolicLink())
    return { available: false, reasonCode: 'AUTH_FILE_SYMLINK' };
  if (!file.isFile())
    return { available: false, reasonCode: 'AUTH_FILE_NOT_REGULAR' };
  if (permissions(file.mode) !== 0o600)
    return { available: false, reasonCode: 'AUTH_FILE_MODE_INVALID' };
  if (file.uid !== owner)
    return { available: false, reasonCode: 'AUTH_FILE_OWNER_INVALID' };
  if (file.size < 1) return { available: false, reasonCode: 'AUTH_FILE_EMPTY' };
  return { available: true, reasonCode: 'AUTH_FILE_READY' };
}

async function createSecureAuthFile(
  stateRoot: string,
  value: string,
  uid?: number,
): Promise<void> {
  if (value.length === 0) throw new Error('Legacy credential was empty.');
  const owner = currentUid(uid);
  const destination = tunnelAuthFilePath(stateRoot);
  const secretsDirectory = path.dirname(destination);
  try {
    await mkdir(secretsDirectory, { mode: 0o700 });
  } catch (error) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    ))
      throw new Error('Unable to create Tunnel secrets directory.');
  }
  const directory = await lstat(secretsDirectory);
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    permissions(directory.mode) !== 0o700 ||
    directory.uid !== owner
  ) {
    throw new Error('Tunnel secrets directory is unsafe.');
  }
  try {
    await lstat(destination);
    throw new Error('Tunnel auth file already exists.');
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = path.join(
    secretsDirectory,
    `.openai-tunnel-runtime.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new Error('Unable to atomically create Tunnel auth file.');
  }
  const result = await inspectTunnelAuthFile(stateRoot, owner);
  if (!result.available)
    throw new Error('Tunnel auth file failed metadata verification.');
}

export async function migrateLegacyKeychainTunnelAuth(
  stateRoot: string,
  reader: LegacyKeychainReader,
  uid?: number,
): Promise<{ readonly migrated: true; readonly authFileAvailable: true }> {
  const existing = await inspectTunnelAuthFile(stateRoot, uid);
  if (existing.available) throw new Error('Tunnel auth file already exists.');
  let value: string | undefined;
  try {
    value = await reader.read(
      LEGACY_TUNNEL_KEYCHAIN_SERVICE,
      LEGACY_TUNNEL_KEYCHAIN_ACCOUNT,
    );
  } catch {
    throw new Error('Legacy Keychain credential migration failed.');
  }
  if (value === undefined || value.length === 0)
    throw new Error('Legacy Keychain credential migration failed.');
  await createSecureAuthFile(stateRoot, value, uid);
  return { migrated: true, authFileAvailable: true };
}
