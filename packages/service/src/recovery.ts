import { ServiceFoundationError } from './errors.js';
import type {
  RecoverableServiceId,
  RecoveryAction,
  RecoveryDecision,
  RecoveryInput,
  ServiceStatus,
} from './types.js';

export const DEFAULT_RECOVERY_POLICY = {
  baseBackoffMs: 5_000,
  maxBackoffMs: 300_000,
  restartWindowMs: 600_000,
  maxAttempts: 5,
  cooldownMs: 900_000,
} as const;

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ServiceFoundationError(
      'RECOVERY_INPUT_INVALID',
      `${field} must be an ISO-compatible timestamp.`,
    );
  }
  return parsed;
}

function validate(input: RecoveryInput): number {
  const policyValues = [
    input.policy.baseBackoffMs,
    input.policy.maxBackoffMs,
    input.policy.restartWindowMs,
    input.policy.maxAttempts,
    input.policy.cooldownMs,
  ];
  if (
    policyValues.some((value) => !Number.isInteger(value) || value <= 0) ||
    input.policy.maxBackoffMs < input.policy.baseBackoffMs
  ) {
    throw new ServiceFoundationError(
      'RECOVERY_INPUT_INVALID',
      'Recovery policy values must be positive bounded integers.',
    );
  }
  const now = timestamp(input.now, 'now');
  for (const event of input.restartHistory) {
    if (timestamp(event.at, 'restart event') > now) {
      throw new ServiceFoundationError(
        'RECOVERY_INPUT_INVALID',
        'Restart history must not contain future events.',
      );
    }
  }
  return now;
}

function decision(
  input: RecoveryInput,
  action: RecoveryAction,
  reasonCode: string,
  options: {
    readonly serviceId?: RecoverableServiceId;
    readonly delayMs?: number;
    readonly cooldownUntil?: string;
    readonly suggestedCleanup?: 'remove_stale_pid_or_lock_after_owner_check';
  } = {},
): RecoveryDecision {
  return {
    action,
    ...options,
    reasonCode,
    checkedAt: input.now,
    oneShot: true,
  };
}

function staleState(status: ServiceStatus): boolean {
  return status.reasonCodes.some((reason) =>
    ['STALE_PID_OBSERVED', 'STALE_LOCK_OBSERVED'].includes(reason),
  );
}

function boundedAction(
  input: RecoveryInput,
  status: ServiceStatus,
  serviceId: RecoverableServiceId,
  action: 'start' | 'restart',
  reasonCode: string,
  now: number,
): RecoveryDecision {
  if (status.cooldownUntil !== undefined) {
    const cooldownUntil = timestamp(status.cooldownUntil, 'cooldownUntil');
    if (cooldownUntil > now) {
      return decision(input, 'wait_backoff', 'RECOVERY_COOLDOWN_ACTIVE', {
        serviceId,
        delayMs: cooldownUntil - now,
        cooldownUntil: status.cooldownUntil,
      });
    }
  }
  const windowStart = now - input.policy.restartWindowMs;
  const history = input.restartHistory
    .filter(
      (event) =>
        event.serviceId === serviceId &&
        timestamp(event.at, 'restart event') >= windowStart,
    )
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (history.length >= input.policy.maxAttempts) {
    return decision(input, 'manual_intervention', 'RESTART_STORM_DETECTED', {
      serviceId,
      cooldownUntil: new Date(now + input.policy.cooldownMs).toISOString(),
    });
  }
  const last = history.at(-1);
  if (last !== undefined) {
    const delay = Math.min(
      input.policy.baseBackoffMs * 2 ** Math.max(0, history.length - 1),
      input.policy.maxBackoffMs,
    );
    const remaining = timestamp(last.at, 'restart event') + delay - now;
    if (remaining > 0) {
      return decision(input, 'wait_backoff', 'EXPONENTIAL_BACKOFF_ACTIVE', {
        serviceId,
        delayMs: remaining,
      });
    }
  }
  return decision(input, action, reasonCode, { serviceId });
}

function manualPrecondition(
  input: RecoveryInput,
  serviceId: RecoverableServiceId,
): RecoveryDecision | undefined {
  const status = serviceId === 'localink-core' ? input.core : input.tunnel;
  const config =
    serviceId === 'localink-core' ? input.coreConfig : input.tunnelConfig;
  if (config === 'invalid') {
    return decision(input, 'manual_intervention', 'CONFIG_INVALID', {
      serviceId,
    });
  }
  if (staleState(status)) {
    return decision(
      input,
      'manual_intervention',
      'STALE_STATE_REQUIRES_REVIEW',
      {
        serviceId,
        suggestedCleanup: 'remove_stale_pid_or_lock_after_owner_check',
      },
    );
  }
  if (serviceId === 'localink-tunnel') {
    if (input.tunnelSecret === 'missing') {
      return decision(input, 'manual_intervention', 'TUNNEL_SECRET_MISSING', {
        serviceId,
      });
    }
    if (input.tunnelAuth === 'failed') {
      return decision(input, 'manual_intervention', 'TUNNEL_AUTH_FAILED', {
        serviceId,
      });
    }
  }
  return undefined;
}

export function decideRecovery(input: RecoveryInput): RecoveryDecision {
  const now = validate(input);
  if (input.operatorIntent.kind !== 'automatic') {
    const precondition = manualPrecondition(
      input,
      input.operatorIntent.serviceId,
    );
    if (precondition !== undefined && input.operatorIntent.kind !== 'stop') {
      return precondition;
    }
    return decision(input, input.operatorIntent.kind, 'OPERATOR_INTENT', {
      serviceId: input.operatorIntent.serviceId,
    });
  }

  const corePrecondition = manualPrecondition(input, 'localink-core');
  if (corePrecondition !== undefined) return corePrecondition;
  if (!input.core.processRunning) {
    return boundedAction(
      input,
      input.core,
      'localink-core',
      'start',
      'CORE_PROCESS_STOPPED',
      now,
    );
  }
  if (input.localMcpReadiness === 'failed') {
    return boundedAction(
      input,
      input.core,
      'localink-core',
      'restart',
      'LOCAL_MCP_NOT_READY',
      now,
    );
  }
  if (input.localMcpReadiness === 'unknown') {
    return decision(input, 'no_action', 'LOCAL_MCP_READINESS_UNKNOWN', {
      serviceId: 'localink-core',
    });
  }

  const tunnelPrecondition = manualPrecondition(input, 'localink-tunnel');
  if (tunnelPrecondition !== undefined) return tunnelPrecondition;
  if (!input.tunnel.installed) {
    return decision(input, 'no_action', 'TUNNEL_NOT_ACTIVATED', {
      serviceId: 'localink-tunnel',
    });
  }
  if (!input.tunnel.processRunning) {
    return boundedAction(
      input,
      input.tunnel,
      'localink-tunnel',
      'start',
      'TUNNEL_PROCESS_STOPPED',
      now,
    );
  }
  if (input.tunnelConnected === 'failed' || input.tunnelReady === 'failed') {
    return boundedAction(
      input,
      input.tunnel,
      'localink-tunnel',
      'restart',
      'TUNNEL_NOT_READY',
      now,
    );
  }
  if (input.tunnelConnected === 'ready' && input.tunnelReady === 'ready') {
    return decision(input, 'no_action', 'SERVICES_READY');
  }
  return decision(input, 'no_action', 'TUNNEL_READINESS_UNKNOWN', {
    serviceId: 'localink-tunnel',
  });
}
