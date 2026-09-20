import { ServiceFoundationError } from './errors.js';
import type { LocalinkServiceTopologyStatus, ServiceStatus } from './types.js';

export type ServiceStatusInput = Omit<ServiceStatus, 'reasonCodes'> & {
  readonly reasonCodes?: readonly string[];
};

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function createServiceStatus(input: ServiceStatusInput): ServiceStatus {
  if (
    !Number.isInteger(input.recentRestarts) ||
    input.recentRestarts < 0 ||
    !validTimestamp(input.checkedAt) ||
    (input.cooldownUntil !== undefined &&
      !validTimestamp(input.cooldownUntil)) ||
    (input.lastExit !== undefined && !validTimestamp(input.lastExit.at)) ||
    (input.pid !== undefined &&
      (!Number.isInteger(input.pid) || input.pid <= 0))
  ) {
    throw new ServiceFoundationError(
      'RECOVERY_INPUT_INVALID',
      'Service status contains invalid process or time fields.',
    );
  }
  const reasons = new Set(input.reasonCodes ?? []);
  if (!input.processRunning && input.pid !== undefined) {
    reasons.add('STALE_PID_OBSERVED');
  }
  if (!input.installed && input.processRunning) {
    reasons.add('UNMANAGED_PROCESS_RUNNING');
  }
  return {
    serviceId: input.serviceId,
    installed: input.installed,
    processRunning: input.processRunning,
    ...(input.pid === undefined ? {} : { pid: input.pid }),
    readiness: input.readiness,
    ...(input.lastExit === undefined ? {} : { lastExit: input.lastExit }),
    recentRestarts: input.recentRestarts,
    ...(input.cooldownUntil === undefined
      ? {}
      : { cooldownUntil: input.cooldownUntil }),
    reasonCodes: [...reasons],
    checkedAt: input.checkedAt,
  };
}

export function composeServiceTopologyStatus(input: {
  readonly core: ServiceStatus;
  readonly localMcpReadiness: LocalinkServiceTopologyStatus['localMcpReadiness'];
  readonly tunnel: ServiceStatus;
  readonly tunnelConnected: LocalinkServiceTopologyStatus['tunnelConnected'];
  readonly tunnelReady: LocalinkServiceTopologyStatus['tunnelReady'];
  readonly checkedAt: string;
}): LocalinkServiceTopologyStatus {
  if (!validTimestamp(input.checkedAt)) {
    throw new ServiceFoundationError(
      'RECOVERY_INPUT_INVALID',
      'Topology status checkedAt is invalid.',
    );
  }
  return { ...input };
}
