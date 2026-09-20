import type { CapabilityRegistry, SkillRegistry } from '@localink/core';
import type { NativeToolFacade } from '@localink/runtime';

export interface PublicRuntime {
  readonly capabilities: CapabilityRegistry;
  readonly skills: SkillRegistry;
  readonly native?: NativeToolFacade;
  health(): Promise<unknown>;
  validateInput(capabilityId: string, input: unknown): void;
}
