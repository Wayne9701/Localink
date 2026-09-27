import type { CapabilityRegistry, SkillRegistry } from '@localink/core';
import type { NativeToolFacade } from '@localink/runtime';

// PublicAdapter validates the full strict Zod schema before calling these
// methods. The structural inputs keep the transport independent of the Agent
// package while remaining assignable to its richer optional input types.
export interface AgentController {
  start(input: {
    workspaceId: string;
    relativeCwd?: string | undefined;
    taskTitle: string;
    prompt: string;
    supervisionMode?: 'auto' | 'inline' | 'detached' | undefined;
    model?: string | undefined;
    reasoningEffort?: string | undefined;
    invocationRationale?: string | undefined;
  }): Promise<unknown>;
  list(input: {
    workspaceId?: string | undefined;
    status?:
      | 'starting'
      | 'running'
      | 'awaiting_approval'
      | 'awaiting_interaction'
      | 'completed'
      | 'failed'
      | 'cancelled'
      | 'unknown'
      | undefined;
    limit?: number | undefined;
  }): Promise<unknown>;
  show(input: { agentRef: string }): Promise<unknown>;
  wait(input: {
    agentRef: string;
    afterSeq?: number | undefined;
    timeoutMs?: number | undefined;
  }): Promise<unknown>;
  send(input: {
    agentRef: string;
    message: string;
    model?: string | undefined;
    reasoningEffort?: string | undefined;
    invocationRationale?: string | undefined;
  }): Promise<unknown>;
  approve(input: {
    agentRef: string;
    approvalRequestId: string;
  }): Promise<unknown>;
  reject(input: {
    agentRef: string;
    approvalRequestId: string;
  }): Promise<unknown>;
  cancel(input: { agentRef: string }): Promise<unknown>;
  archive(input: { agentRef: string }): Promise<unknown>;
}

export interface PublicRuntime {
  readonly capabilities: CapabilityRegistry;
  readonly skills: SkillRegistry;
  readonly native?: NativeToolFacade;
  readonly agents?: AgentController | undefined;
  refreshWorkspaces?(): Promise<void>;
  refreshProcessPolicy?(): Promise<void>;
  refreshSkillSources?(): Promise<void>;
  refreshExternalMcp?(): Promise<void>;
  refreshAgents?(): Promise<void>;
  health(): Promise<unknown>;
  validateInput(capabilityId: string, input: unknown): void;
}
