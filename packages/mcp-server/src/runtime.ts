import type { CapabilityRegistry, SkillRegistry } from '@localink/core';

export interface PublicRuntime {
  readonly capabilities: CapabilityRegistry;
  readonly skills: SkillRegistry;
  health(): Promise<unknown>;
  validateInput(capabilityId: string, input: unknown): void;
}
