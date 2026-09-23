export type ReleaseReadinessCode =
  | 'LOCAL_STARTUP_TIMEOUT'
  | 'LOCAL_MCP_FAILED'
  | 'TUNNEL_PROCESS_STOPPED'
  | 'CONTROL_PLANE_POLL_TIMEOUT'
  | 'CONTROL_PLANE_HEALTH_FAILED'
  | 'ROLLBACK_READINESS_FAILED';

export class ReleaseReadinessError extends Error {
  readonly code: ReleaseReadinessCode;

  constructor(code: ReleaseReadinessCode, message: string) {
    super(message);
    this.name = 'ReleaseReadinessError';
    this.code = code;
  }
}

export interface LocalStartupSnapshot {
  readonly mcpReady: boolean;
  readonly toolCount?: number;
  readonly coreInstalled: boolean;
  readonly coreRunning: boolean;
  readonly tunnelInstalled: boolean;
  readonly tunnelRunning: boolean;
  readonly recoveryInstalled: boolean;
}

export interface ControlPlaneSnapshot {
  readonly coreMcpReady: boolean;
  readonly tunnelRunning: boolean;
  readonly pollReady: boolean;
  readonly healthFatal?: boolean;
}

interface WaitClock {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForLocalStartup(
  probe: () => Promise<LocalStartupSnapshot>,
  options: WaitClock & {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly expectedToolCount: number;
  },
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = now() + timeoutMs;
  let last: LocalStartupSnapshot | undefined;

  while (now() < deadline) {
    last = await probe();
    if (
      last.mcpReady &&
      last.toolCount === options.expectedToolCount &&
      last.coreInstalled &&
      last.coreRunning &&
      last.tunnelInstalled &&
      last.tunnelRunning &&
      last.recoveryInstalled
    ) {
      return;
    }
    await sleep(intervalMs);
  }

  if (
    last?.coreInstalled === true &&
    last.coreRunning === true &&
    (!last.mcpReady || last.toolCount !== options.expectedToolCount)
  ) {
    throw new ReleaseReadinessError(
      'LOCAL_MCP_FAILED',
      'Local MCP did not become ready within the startup window.',
    );
  }

  throw new ReleaseReadinessError(
    'LOCAL_STARTUP_TIMEOUT',
    'Managed Localink services did not become ready within the startup window.',
  );
}

export async function waitForControlPlaneReadiness(
  probe: () => Promise<ControlPlaneSnapshot>,
  options: WaitClock & {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const snapshot = await probe();
    if (snapshot.healthFatal === true) {
      throw new ReleaseReadinessError(
        'CONTROL_PLANE_HEALTH_FAILED',
        'Tunnel health probe is unavailable.',
      );
    }
    if (!snapshot.tunnelRunning) {
      throw new ReleaseReadinessError(
        'TUNNEL_PROCESS_STOPPED',
        'Tunnel process stopped while waiting for control-plane readiness.',
      );
    }
    if (!snapshot.coreMcpReady) {
      throw new ReleaseReadinessError(
        'LOCAL_MCP_FAILED',
        'Local MCP became unavailable while waiting for control-plane readiness.',
      );
    }
    if (snapshot.pollReady) return;
    await sleep(intervalMs);
  }

  throw new ReleaseReadinessError(
    'CONTROL_PLANE_POLL_TIMEOUT',
    'No successful control-plane poll was observed within the bounded readiness window.',
  );
}
