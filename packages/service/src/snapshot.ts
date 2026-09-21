import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const SERVICE_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_SNAPSHOT_FRESHNESS_MS = 120_000;

export type SnapshotReadiness = 'ready' | 'failed' | 'unknown';

export interface PublicServiceSnapshot {
  readonly version: typeof SERVICE_SNAPSHOT_VERSION;
  readonly checkedAt: string;
  readonly stale: boolean;
  readonly core: {
    readonly installed: boolean;
    readonly processRunning: boolean;
    readonly readiness: SnapshotReadiness;
    readonly reasonCodes: readonly string[];
  };
  readonly localMcpReadiness: SnapshotReadiness;
  readonly tunnel: {
    readonly configured: boolean;
    readonly secretAvailable: boolean;
    readonly installed: boolean;
    readonly processRunning: boolean;
    readonly binaryAvailable: boolean;
    readonly versionCompatibility:
      'tested' | 'supported' | 'unsupported' | 'unknown';
    readonly profileValid: SnapshotReadiness;
    readonly controlPlaneAuth: SnapshotReadiness;
    readonly connected: SnapshotReadiness;
    readonly ready: SnapshotReadiness;
    readonly reasonCodes: readonly string[];
  };
  readonly recovery: {
    readonly installed: boolean;
    readonly lastAction:
      | 'none'
      | 'no_action'
      | 'start'
      | 'restart'
      | 'stop'
      | 'wait_backoff'
      | 'manual_intervention';
    readonly reasonCode?: string;
    readonly cooldownUntil?: string;
  };
  readonly clientBinding: { readonly state: 'not_observable' };
}

export type ServiceSnapshotInput = Omit<PublicServiceSnapshot, 'stale'>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strictKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function reasons(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (item) => typeof item === 'string' && /^[A-Z0-9_]{1,96}$/u.test(item),
    )
  );
}

function readiness(value: unknown): value is SnapshotReadiness {
  return ['ready', 'failed', 'unknown'].includes(String(value));
}

function validateSnapshot(value: unknown): ServiceSnapshotInput | undefined {
  const root = record(value);
  if (
    root === undefined ||
    !strictKeys(root, [
      'version',
      'checkedAt',
      'core',
      'localMcpReadiness',
      'tunnel',
      'recovery',
      'clientBinding',
    ]) ||
    root.version !== SERVICE_SNAPSHOT_VERSION ||
    typeof root.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(root.checkedAt)) ||
    !readiness(root.localMcpReadiness)
  ) {
    return undefined;
  }
  const core = record(root.core);
  const tunnel = record(root.tunnel);
  const recovery = record(root.recovery);
  const binding = record(root.clientBinding);
  if (
    core === undefined ||
    !strictKeys(core, [
      'installed',
      'processRunning',
      'readiness',
      'reasonCodes',
    ]) ||
    typeof core.installed !== 'boolean' ||
    typeof core.processRunning !== 'boolean' ||
    !readiness(core.readiness) ||
    !reasons(core.reasonCodes) ||
    tunnel === undefined ||
    !strictKeys(tunnel, [
      'configured',
      'secretAvailable',
      'installed',
      'processRunning',
      'binaryAvailable',
      'versionCompatibility',
      'profileValid',
      'controlPlaneAuth',
      'connected',
      'ready',
      'reasonCodes',
    ]) ||
    typeof tunnel.configured !== 'boolean' ||
    typeof tunnel.secretAvailable !== 'boolean' ||
    typeof tunnel.installed !== 'boolean' ||
    typeof tunnel.processRunning !== 'boolean' ||
    typeof tunnel.binaryAvailable !== 'boolean' ||
    !['tested', 'supported', 'unsupported', 'unknown'].includes(
      String(tunnel.versionCompatibility),
    ) ||
    !readiness(tunnel.profileValid) ||
    !readiness(tunnel.controlPlaneAuth) ||
    !readiness(tunnel.connected) ||
    !readiness(tunnel.ready) ||
    !reasons(tunnel.reasonCodes) ||
    recovery === undefined ||
    typeof recovery.installed !== 'boolean' ||
    ![
      'none',
      'no_action',
      'start',
      'restart',
      'stop',
      'wait_backoff',
      'manual_intervention',
    ].includes(String(recovery.lastAction)) ||
    (recovery.reasonCode !== undefined &&
      (typeof recovery.reasonCode !== 'string' ||
        !/^[A-Z0-9_]{1,96}$/u.test(recovery.reasonCode))) ||
    (recovery.cooldownUntil !== undefined &&
      (typeof recovery.cooldownUntil !== 'string' ||
        !Number.isFinite(Date.parse(recovery.cooldownUntil)))) ||
    !strictKeys(recovery, [
      'installed',
      'lastAction',
      ...(recovery.reasonCode === undefined ? [] : ['reasonCode']),
      ...(recovery.cooldownUntil === undefined ? [] : ['cooldownUntil']),
    ]) ||
    binding === undefined ||
    !strictKeys(binding, ['state']) ||
    binding.state !== 'not_observable'
  ) {
    return undefined;
  }
  return value as ServiceSnapshotInput;
}

export function serviceSnapshotPath(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'state', 'service-status.json');
}

export async function writeServiceSnapshot(
  stateRoot: string,
  input: ServiceSnapshotInput,
): Promise<PublicServiceSnapshot> {
  const validated = validateSnapshot(input);
  if (validated === undefined) throw new Error('Invalid service snapshot.');
  const destination = serviceSnapshotPath(stateRoot);
  const temporary = path.join(
    path.dirname(destination),
    `.service-status.${randomUUID()}.tmp`,
  );
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { ...validated, stale: false };
}

export async function readServiceSnapshot(
  stateRoot: string,
  options: { readonly now?: number; readonly freshnessMs?: number } = {},
): Promise<PublicServiceSnapshot | undefined> {
  let source: string;
  try {
    source = await readFile(serviceSnapshotPath(stateRoot), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
  const snapshot = validateSnapshot(parsed);
  if (snapshot === undefined) return undefined;
  const now = options.now ?? Date.now();
  const freshnessMs = options.freshnessMs ?? DEFAULT_SNAPSHOT_FRESHNESS_MS;
  return {
    ...snapshot,
    stale: now - Date.parse(snapshot.checkedAt) > freshnessMs,
  };
}

export function unconfiguredServiceSnapshot(): {
  readonly state: 'unconfigured';
  readonly stale: true;
} {
  return { state: 'unconfigured', stale: true };
}
