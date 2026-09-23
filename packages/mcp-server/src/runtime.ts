import type { CapabilityRegistry, SkillRegistry } from '@localink/core';
import type { NativeToolFacade } from '@localink/runtime';

export interface PublicRuntime {
  readonly capabilities: CapabilityRegistry;
  readonly skills: SkillRegistry;
  readonly native?: NativeToolFacade;
  refreshWorkspaces?(): Promise<void>;
  refreshProcessPolicy?(): Promise<void>;
  refreshSkillSources?(): Promise<void>;
  refreshExternalMcp?(): Promise<void>;
  health(): Promise<unknown>;
  validateInput(capabilityId: string, input: unknown): void;
}
