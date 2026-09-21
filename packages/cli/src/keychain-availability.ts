import type { SecretRef } from '@localink/sdk';
import { MacOSKeychainAdapter } from '@localink/service';

export interface KeychainAvailabilityAdapter {
  exists(service: string, account: string): Promise<boolean>;
}

export interface KeychainAvailabilityProbe {
  exists(ref: SecretRef): Promise<boolean>;
}

function serviceName(ref: SecretRef): string {
  if (ref.provider !== 'macos-keychain')
    throw new Error('Tunnel availability requires the macOS Keychain.');
  return `localink.${ref.namespace ?? 'default'}`;
}

export function createKeychainAvailabilityProbe(
  adapter: KeychainAvailabilityAdapter = new MacOSKeychainAdapter(),
): KeychainAvailabilityProbe {
  return {
    async exists(ref) {
      try {
        return await adapter.exists(serviceName(ref), ref.key);
      } catch {
        throw new Error('Keychain availability check failed.');
      }
    },
  };
}
