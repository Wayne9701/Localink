import {
  LocalinkError,
  type SecretMutationReceipt,
  type SecretProvider,
  type SecretRef,
  type SecretValueHandle,
} from '@localink/sdk';
import { validateSecretRef } from '../contracts/validation.js';

const REDACTED = '[REDACTED]' as const;

export class SecretValue implements SecretValueHandle {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): typeof REDACTED {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): typeof REDACTED {
    return REDACTED;
  }

  toString(): typeof REDACTED {
    return REDACTED;
  }
}

function refKey(ref: SecretRef): string {
  return `${ref.namespace ?? 'default'}\0${ref.key}`;
}

function cloneRef(ref: SecretRef): SecretRef {
  return structuredClone(ref);
}

export class InMemorySecretProvider implements SecretProvider {
  readonly id: string;
  readonly #values = new Map<string, string>();

  constructor(id = 'memory') {
    this.id = id;
  }

  async get(ref: SecretRef): Promise<SecretValue | undefined> {
    validateSecretRef(ref, this.id);
    const value = this.#values.get(refKey(ref));
    return value === undefined ? undefined : new SecretValue(value);
  }

  async set(ref: SecretRef, value: string): Promise<SecretMutationReceipt> {
    validateSecretRef(ref, this.id);
    if (typeof value !== 'string') {
      throw new LocalinkError(
        'CONTRACT_INVALID',
        'Secret value must be a string.',
      );
    }
    this.#values.set(refKey(ref), value);
    return { ref: cloneRef(ref), operation: 'set', changed: true };
  }

  async delete(ref: SecretRef): Promise<SecretMutationReceipt> {
    validateSecretRef(ref, this.id);
    return {
      ref: cloneRef(ref),
      operation: 'delete',
      changed: this.#values.delete(refKey(ref)),
    };
  }
}

export interface MacOSKeychainAdapter {
  read(service: string, account: string): Promise<string | undefined>;
  write(service: string, account: string, value: string): Promise<void>;
  remove(service: string, account: string): Promise<boolean>;
}

export class MacOSKeychainSecretProvider implements SecretProvider {
  readonly id = 'macos-keychain';
  readonly #adapter: MacOSKeychainAdapter;

  constructor(adapter: MacOSKeychainAdapter) {
    this.#adapter = adapter;
  }

  async get(ref: SecretRef): Promise<SecretValue | undefined> {
    validateSecretRef(ref, this.id);
    try {
      const value = await this.#adapter.read(this.#service(ref), ref.key);
      return value === undefined ? undefined : new SecretValue(value);
    } catch {
      throw new LocalinkError('SECRET_PROVIDER_ERROR', 'Keychain read failed.');
    }
  }

  async set(ref: SecretRef, value: string): Promise<SecretMutationReceipt> {
    validateSecretRef(ref, this.id);
    try {
      await this.#adapter.write(this.#service(ref), ref.key, value);
      return { ref: cloneRef(ref), operation: 'set', changed: true };
    } catch {
      throw new LocalinkError(
        'SECRET_PROVIDER_ERROR',
        'Keychain write failed.',
      );
    }
  }

  async delete(ref: SecretRef): Promise<SecretMutationReceipt> {
    validateSecretRef(ref, this.id);
    try {
      return {
        ref: cloneRef(ref),
        operation: 'delete',
        changed: await this.#adapter.remove(this.#service(ref), ref.key),
      };
    } catch {
      throw new LocalinkError(
        'SECRET_PROVIDER_ERROR',
        'Keychain delete failed.',
      );
    }
  }

  #service(ref: SecretRef): string {
    return `localink.${ref.namespace ?? 'default'}`;
  }
}
