import { LocalinkError } from '@localink/sdk';

export const PROCESS_POLICY_SCHEMA_VERSION = 1;

export interface ProcessPolicy {
  readonly version: typeof PROCESS_POLICY_SCHEMA_VERSION;
  readonly enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateProcessPolicy(value: unknown): ProcessPolicy {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['version', 'enabled'].includes(key)) ||
    value.version !== PROCESS_POLICY_SCHEMA_VERSION ||
    typeof value.enabled !== 'boolean'
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Process policy must use schema version 1.',
    );
  }
  return {
    version: PROCESS_POLICY_SCHEMA_VERSION,
    enabled: value.enabled,
  };
}
