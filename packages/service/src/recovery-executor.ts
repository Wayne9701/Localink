import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { decideRecovery, DEFAULT_RECOVERY_POLICY } from './recovery.js';
import type {
  RecoverableServiceId,
  RecoveryDecision,
  RecoveryInput,
  RestartEvent,
} from './types.js';

interface RecoveryState {
  readonly version: 1;
  readonly restartHistory: readonly RestartEvent[];
  readonly cooldowns: Readonly<Partial<Record<RecoverableServiceId, string>>>;
  readonly lastDecision?: RecoveryDecision;
}

export interface RecoveryExecutorDependencies {
  readonly stateRoot: string;
  readonly now?: () => Date;
  readonly collect: () => Promise<
    Omit<RecoveryInput, 'restartHistory' | 'now' | 'policy' | 'operatorIntent'>
  >;
  readonly mutate: (
    serviceId: RecoverableServiceId,
    action: 'start' | 'restart' | 'stop',
  ) => Promise<void>;
  readonly writeSnapshot: (decision: RecoveryDecision) => Promise<void>;
}

function recoveryStatePath(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'state', 'recovery-state.json');
}

function cleanState(value: unknown): RecoveryState {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { version: 1, restartHistory: [], cooldowns: {} };
  const input = value as Record<string, unknown>;
  const history = Array.isArray(input.restartHistory)
    ? input.restartHistory.filter(
        (event): event is RestartEvent =>
          typeof event === 'object' &&
          event !== null &&
          !Array.isArray(event) &&
          ['localink-core', 'localink-tunnel'].includes(
            String((event as Record<string, unknown>).serviceId),
          ) &&
          typeof (event as Record<string, unknown>).at === 'string' &&
          Number.isFinite(
            Date.parse(String((event as Record<string, unknown>).at)),
          ),
      )
    : [];
  const rawCooldowns =
    typeof input.cooldowns === 'object' && input.cooldowns !== null
      ? (input.cooldowns as Record<string, unknown>)
      : {};
  const cooldowns: Partial<Record<RecoverableServiceId, string>> = {};
  for (const serviceId of ['localink-core', 'localink-tunnel'] as const) {
    const value = rawCooldowns[serviceId];
    if (typeof value === 'string' && Number.isFinite(Date.parse(value)))
      cooldowns[serviceId] = value;
  }
  return {
    version: 1,
    restartHistory: history.slice(-64),
    cooldowns,
    ...(typeof input.lastDecision === 'object' && input.lastDecision !== null
      ? { lastDecision: input.lastDecision as RecoveryDecision }
      : {}),
  };
}

async function readState(stateRoot: string): Promise<RecoveryState> {
  try {
    return cleanState(
      JSON.parse(
        await readFile(recoveryStatePath(stateRoot), 'utf8'),
      ) as unknown,
    );
  } catch {
    return { version: 1, restartHistory: [], cooldowns: {} };
  }
}

async function writeState(
  stateRoot: string,
  state: RecoveryState,
): Promise<void> {
  const destination = recoveryStatePath(stateRoot);
  const temporary = path.join(
    path.dirname(destination),
    `.recovery-state.${randomUUID()}.tmp`,
  );
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function executeRecoveryOnce(
  dependencies: RecoveryExecutorDependencies,
): Promise<RecoveryDecision> {
  const now = (dependencies.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const [collected, previous] = await Promise.all([
    dependencies.collect(),
    readState(dependencies.stateRoot),
  ]);
  const withCooldown = {
    ...collected,
    core: {
      ...collected.core,
      ...(previous.cooldowns['localink-core'] === undefined
        ? {}
        : { cooldownUntil: previous.cooldowns['localink-core'] }),
    },
    tunnel: {
      ...collected.tunnel,
      ...(previous.cooldowns['localink-tunnel'] === undefined
        ? {}
        : { cooldownUntil: previous.cooldowns['localink-tunnel'] }),
    },
  };
  const recent = previous.restartHistory.filter(
    (event) =>
      Date.parse(event.at) >=
      now.getTime() - DEFAULT_RECOVERY_POLICY.restartWindowMs,
  );
  const decision = decideRecovery({
    ...withCooldown,
    restartHistory: recent,
    now: nowIso,
    policy: DEFAULT_RECOVERY_POLICY,
    operatorIntent: { kind: 'automatic' },
  });
  const history = [...recent];
  const cooldowns = { ...previous.cooldowns };
  if (
    decision.serviceId !== undefined &&
    ['start', 'restart', 'stop'].includes(decision.action)
  ) {
    await dependencies.mutate(
      decision.serviceId,
      decision.action as 'start' | 'restart' | 'stop',
    );
    if (decision.action !== 'stop')
      history.push({ serviceId: decision.serviceId, at: nowIso });
  }
  if (decision.serviceId !== undefined && decision.cooldownUntil !== undefined)
    cooldowns[decision.serviceId] = decision.cooldownUntil;
  await writeState(dependencies.stateRoot, {
    version: 1,
    restartHistory: history.slice(-64),
    cooldowns,
    lastDecision: decision,
  });
  await dependencies.writeSnapshot(decision);
  return decision;
}
