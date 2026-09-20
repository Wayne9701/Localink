import { TunnelAdapterError } from './errors.js';
import type { DoctorLayerResult, Readiness } from './types.js';

const UNKNOWN_RESULT: DoctorLayerResult = {
  profileValid: 'unknown',
  tunnelIdPresent: 'unknown',
  localMcpConfigured: 'unknown',
  localMcpReachable: 'unknown',
  controlPlaneAuth: 'unknown',
  tunnelConnected: 'unknown',
  tunnelReady: 'unknown',
  reasonCodes: [],
};

function readiness(value: unknown): Readiness {
  if (value === true) return 'ready';
  if (value === false) return 'failed';
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.toLowerCase();
  if (
    [
      'ready',
      'ok',
      'pass',
      'passed',
      'healthy',
      'connected',
      'reachable',
    ].includes(normalized)
  ) {
    return 'ready';
  }
  if (
    [
      'failed',
      'fail',
      'error',
      'unhealthy',
      'disconnected',
      'unreachable',
    ].includes(normalized)
  ) {
    return 'failed';
  }
  return 'unknown';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nested(
  root: Record<string, unknown>,
  parent: string,
  key: string,
): unknown {
  return record(root[parent])?.[key];
}

function reasonCodes(root: Record<string, unknown>): string[] {
  const value = root.reason_codes ?? root.reasonCodes ?? root.reasons;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function applyCheck(
  result: Record<keyof Omit<DoctorLayerResult, 'reasonCodes'>, Readiness>,
  id: string,
  status: Readiness,
): boolean {
  const mapping: Readonly<Record<string, keyof typeof result>> = {
    profile: 'profileValid',
    profile_valid: 'profileValid',
    config: 'profileValid',
    config_valid: 'profileValid',
    tunnel_id: 'tunnelIdPresent',
    tunnel_id_present: 'tunnelIdPresent',
    mcp_target: 'localMcpConfigured',
    mcp_target_configured: 'localMcpConfigured',
    mcp_target_reachable: 'localMcpReachable',
    local_mcp_reachable: 'localMcpReachable',
    control_plane_auth: 'controlPlaneAuth',
    tunnel_connected: 'tunnelConnected',
    tunnel_ready: 'tunnelReady',
  };
  const key = mapping[id.toLowerCase()];
  if (key === undefined) return false;
  result[key] = status;
  return true;
}

export function parseDoctorJson(value: unknown): DoctorLayerResult {
  const root = record(value);
  if (root === undefined) {
    throw new TunnelAdapterError(
      'DOCTOR_OUTPUT_MALFORMED',
      'Doctor JSON must be an object.',
    );
  }
  const mutable = {
    profileValid: readiness(
      nested(root, 'profile', 'valid') ?? nested(root, 'config', 'valid'),
    ),
    tunnelIdPresent: readiness(
      nested(root, 'profile', 'tunnel_id_present') ?? root.tunnel_id_present,
    ),
    localMcpConfigured: readiness(
      nested(root, 'local_mcp', 'configured') ?? root.local_mcp_configured,
    ),
    localMcpReachable: readiness(
      nested(root, 'local_mcp', 'reachable') ?? root.local_mcp_reachable,
    ),
    controlPlaneAuth: readiness(
      nested(root, 'control_plane', 'auth') ?? root.control_plane_auth,
    ),
    tunnelConnected: readiness(
      nested(root, 'tunnel', 'connected') ?? root.tunnel_connected,
    ),
    tunnelReady: readiness(
      nested(root, 'tunnel', 'ready') ?? root.tunnel_ready,
    ),
  };
  let recognized = Object.values(mutable).filter(
    (value) => value !== 'unknown',
  ).length;
  const checks = root.checks;
  if (Array.isArray(checks)) {
    for (const item of checks) {
      const check = record(item);
      const id = check?.id ?? check?.name ?? check?.code;
      if (typeof id !== 'string') continue;
      if (applyCheck(mutable, id, readiness(check?.status ?? check?.ok))) {
        recognized += 1;
      }
    }
  }
  if (recognized === 0) {
    throw new TunnelAdapterError(
      'DOCTOR_OUTPUT_MALFORMED',
      'Doctor JSON contained no recognized status fields.',
    );
  }
  return { ...mutable, reasonCodes: reasonCodes(root) };
}

export function parseDoctorText(output: string): DoctorLayerResult {
  const mutable = { ...UNKNOWN_RESULT, reasonCodes: [] as string[] };
  let recognized = 0;
  for (const line of output.split(/\r?\n/u)) {
    const statusMatch = /^([A-Z_]+)=(ready|failed|unknown)$/u.exec(line.trim());
    if (statusMatch !== null) {
      if (
        applyCheck(mutable, statusMatch[1] ?? '', readiness(statusMatch[2]))
      ) {
        recognized += 1;
      }
      continue;
    }
    const reasonMatch = /^REASON_CODE=([A-Z0-9_]+)$/u.exec(line.trim());
    if (reasonMatch?.[1] !== undefined)
      mutable.reasonCodes.push(reasonMatch[1]);
  }
  if (recognized === 0) {
    throw new TunnelAdapterError(
      'DOCTOR_OUTPUT_MALFORMED',
      'Doctor text contained no recognized machine status lines.',
    );
  }
  return mutable;
}

export function parseDoctorOutput(output: string): DoctorLayerResult {
  const trimmed = output.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      throw new TunnelAdapterError(
        'DOCTOR_OUTPUT_MALFORMED',
        'Doctor returned malformed JSON.',
      );
    }
    return parseDoctorJson(parsed);
  }
  return parseDoctorText(output);
}
