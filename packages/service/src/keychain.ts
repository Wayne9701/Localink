import { execFile } from 'node:child_process';
import type { MacOSKeychainAdapter as KeychainAdapterContract } from '@localink/core';

const SECURITY_BINARY = '/usr/bin/security' as const;

export interface SecurityExecutor {
  execute(
    command: typeof SECURITY_BINARY,
    args: readonly string[],
  ): Promise<{ readonly stdout: string }>;
}

export class SystemSecurityExecutor implements SecurityExecutor {
  execute(
    command: typeof SECURITY_BINARY,
    args: readonly string[],
  ): Promise<{ readonly stdout: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        },
        (error, stdout) => {
          if (error === null) resolve({ stdout });
          else reject(error);
        },
      );
    });
  }
}

function notFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 44 || error.code === '44')
  );
}

function safeIdentifier(value: string, field: string): string {
  if (
    value.length < 1 ||
    value.length > 128 ||
    value.includes('\0') ||
    value.startsWith('-')
  ) {
    throw new Error(`Invalid Keychain ${field}.`);
  }
  return value;
}

/** Read-only M5 boundary. Secret onboarding remains an interactive/M6 concern. */
export class MacOSKeychainAdapter implements KeychainAdapterContract {
  readonly #executor: SecurityExecutor;

  constructor(executor: SecurityExecutor = new SystemSecurityExecutor()) {
    this.#executor = executor;
  }

  async read(service: string, account: string): Promise<string | undefined> {
    const args = [
      'find-generic-password',
      '-s',
      safeIdentifier(service, 'service'),
      '-a',
      safeIdentifier(account, 'account'),
      '-w',
    ] as const;
    try {
      const result = await this.#executor.execute(SECURITY_BINARY, args);
      const value = result.stdout.replace(/\r?\n$/u, '');
      if (value.length === 0) throw new Error('Keychain item was empty.');
      return value;
    } catch (error) {
      if (notFound(error)) return undefined;
      throw new Error('Keychain read failed.');
    }
  }

  /**
   * Checks that an item can be located without requesting its secret value.
   * This is intentionally separate from `read()`: M5 status, doctor, and
   * recovery must never provoke a Keychain authorization prompt.
   */
  async exists(service: string, account: string): Promise<boolean> {
    const args = [
      'find-generic-password',
      '-s',
      safeIdentifier(service, 'service'),
      '-a',
      safeIdentifier(account, 'account'),
    ] as const;
    try {
      await this.#executor.execute(SECURITY_BINARY, args);
      return true;
    } catch (error) {
      if (notFound(error)) return false;
      throw new Error('Keychain availability check failed.');
    }
  }

  async write(): Promise<void> {
    throw new Error('Keychain mutation is not available in M5.');
  }

  async remove(): Promise<boolean> {
    throw new Error('Keychain mutation is not available in M5.');
  }
}
