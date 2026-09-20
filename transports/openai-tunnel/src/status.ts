import type {
  DoctorLayerResult,
  TunnelBinaryStatus,
  TunnelStatus,
} from './types.js';

export function buildTunnelStatus(
  binary: TunnelBinaryStatus,
  doctor?: DoctorLayerResult,
  checkedAt = new Date().toISOString(),
): TunnelStatus {
  const unknown = 'unknown' as const;
  const reasons = new Set(binary.reasonCodes);
  for (const reason of doctor?.reasonCodes ?? []) reasons.add(reason);
  return {
    binaryAvailable: binary.available,
    ...(binary.version === undefined ? {} : { version: binary.version }),
    versionCompatibility: binary.compatibility,
    profileValid: doctor?.profileValid ?? unknown,
    tunnelIdPresent: doctor?.tunnelIdPresent ?? unknown,
    localMcpTarget: {
      configured: doctor?.localMcpConfigured ?? unknown,
      reachable: doctor?.localMcpReachable ?? unknown,
    },
    controlPlaneAuth: doctor?.controlPlaneAuth ?? unknown,
    tunnel: {
      connected: doctor?.tunnelConnected ?? unknown,
      ready: doctor?.tunnelReady ?? unknown,
    },
    reasonCodes: [...reasons],
    checkedAt,
  };
}
