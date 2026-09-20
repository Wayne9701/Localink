import { ServiceFoundationError } from './errors.js';

export type ServiceEntrypoint =
  | { readonly kind: 'core-run' }
  | { readonly kind: 'tunnel-run' }
  | { readonly kind: 'recovery-run'; readonly once: true };

export interface ServiceEntrypointHandlers<T> {
  readonly runCore: () => Promise<T>;
  readonly runTunnel: () => Promise<T>;
  readonly runRecoveryOnce: () => Promise<T>;
}

export function parseServiceEntrypoint(
  args: readonly string[],
): ServiceEntrypoint {
  if (args.length === 2 && args[0] === 'service' && args[1] === 'core-run') {
    return { kind: 'core-run' };
  }
  if (args.length === 2 && args[0] === 'service' && args[1] === 'tunnel-run') {
    return { kind: 'tunnel-run' };
  }
  if (
    args.length === 3 &&
    args[0] === 'service' &&
    args[1] === 'recovery-run' &&
    args[2] === '--once'
  ) {
    return { kind: 'recovery-run', once: true };
  }
  throw new ServiceFoundationError(
    'RECOVERY_INPUT_INVALID',
    'Unknown or unsafe service entrypoint arguments.',
  );
}

export async function dispatchServiceEntrypoint<T>(
  args: readonly string[],
  handlers: ServiceEntrypointHandlers<T>,
): Promise<T> {
  const entrypoint = parseServiceEntrypoint(args);
  if (entrypoint.kind === 'core-run') return handlers.runCore();
  if (entrypoint.kind === 'tunnel-run') return handlers.runTunnel();
  return handlers.runRecoveryOnce();
}
