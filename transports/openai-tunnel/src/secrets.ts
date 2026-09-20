import type {
  SecretProvider,
  SecretRef,
  SecretValueHandle,
} from '@localink/sdk';
import { CONTROL_PLANE_API_KEY_ENV } from './types.js';
import { TunnelAdapterError } from './errors.js';

const REDACTED = '[REDACTED]' as const;

export class TunnelChildEnvironment {
  readonly #value: SecretValueHandle;

  constructor(value: SecretValueHandle) {
    this.#value = value;
  }

  forSpawn(
    baseEnvironment: Readonly<Record<string, string>> = {},
  ): NodeJS.ProcessEnv {
    return {
      ...baseEnvironment,
      [CONTROL_PLANE_API_KEY_ENV]: this.#value.reveal(),
    };
  }

  toJSON(): Readonly<
    Record<typeof CONTROL_PLANE_API_KEY_ENV, typeof REDACTED>
  > {
    return { [CONTROL_PLANE_API_KEY_ENV]: REDACTED };
  }

  toString(): typeof REDACTED {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): typeof REDACTED {
    return REDACTED;
  }
}

export async function resolveTunnelSecretEnvironment(
  provider: SecretProvider,
  ref: SecretRef,
): Promise<TunnelChildEnvironment> {
  if (provider.id !== ref.provider) {
    throw new TunnelAdapterError(
      'SECRET_UNAVAILABLE',
      'Secret provider does not match the requested reference.',
    );
  }
  let value: SecretValueHandle | undefined;
  try {
    value = await provider.get(ref);
  } catch {
    throw new TunnelAdapterError(
      'SECRET_UNAVAILABLE',
      'Tunnel API key could not be resolved.',
    );
  }
  if (value === undefined) {
    throw new TunnelAdapterError(
      'SECRET_UNAVAILABLE',
      'Tunnel API key is not configured.',
    );
  }
  return new TunnelChildEnvironment(value);
}
