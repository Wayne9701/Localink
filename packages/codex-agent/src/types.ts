export type AgentStatus =
  | 'starting'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_interaction'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type SupervisionMode = 'auto' | 'inline' | 'detached';

export interface AgentRuntimeConfig {
  readonly version: 1;
  readonly enabled: boolean;
  readonly codexExecutable?: string;
  readonly permissionPreset: 'auto';
  readonly sectionName: 'Localink Agents';
}

export interface ResolvedAgentWorkspace {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly workspaceName: string;
  readonly authorizationGeneration: string;
}

export interface AgentManagerOptions {
  readonly stateRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly config: AgentRuntimeConfig;
  readonly resolveWorkspace: (
    workspaceId: string,
    relativeCwd?: string,
  ) => Promise<ResolvedAgentWorkspace>;
  readonly clientFactory?: (
    callbacks: AppServerCallbacks,
    launch: { readonly agentRef: string; readonly args: readonly string[] },
  ) => AppServerPort;
  readonly capabilityProjector?: () => Promise<{
    readonly launchArgs: readonly string[];
  }>;
}

export interface AppServerCallbacks {
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onRequest: (
    id: string | number,
    method: string,
    params: unknown,
  ) => void;
  readonly onCrash: (reason: string) => void;
}

export interface AppServerPort {
  start(): Promise<void>;
  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, code: number, message: string): void;
  processId(): number | undefined;
  close(): Promise<void>;
}

export interface AgentTask {
  readonly agentRef: string;
  readonly taskTitle: string;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly relativeCwd: string;
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalCwd: string;
  readonly workspaceAuthorizationGeneration: string;
  readonly canonicalRepoRoot: string;
  readonly repo: string;
  readonly supervisionMode: SupervisionMode;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly permissionPreset: 'auto';
  readonly effectivePermissions?:
    | {
        readonly activePermissionProfile: string;
        readonly approvalPolicy: string;
        readonly approvalsReviewer: string;
      }
    | undefined;
  readonly status: AgentStatus;
  readonly taskStatus: AgentStatus;
  readonly turnStatus?: string | undefined;
  readonly terminal: boolean;
  /** @deprecated Derived alias for repoWriterReleased. */
  readonly writerReleased: boolean;
  readonly repoWriterReleased: boolean;
  readonly taskAppServerState:
    | 'starting'
    | 'running'
    | 'tearing_down'
    | 'release_pending'
    | 'stopped'
    | 'crashed';
  readonly taskAppServerPid?: number | undefined;
  readonly officialSessionReleased: boolean;
  readonly officialThreadLoadState: 'loaded' | 'notLoaded' | 'unknown';
  readonly archived: boolean;
  readonly desktopHistoryReady: boolean;
  readonly workspaceAuthorizationStatus: 'authorized' | 'revoked' | 'unknown';
  readonly capabilityProfile: 'workspace-dev-v1';
  readonly pendingApproval?:
    | {
        readonly approvalRequestId: string;
        readonly kind: 'command' | 'file' | 'permissions';
        readonly summary: string;
        readonly actionable: boolean;
      }
    | undefined;
  readonly pendingInteraction?:
    | {
        readonly kind: 'mcp_elicitation' | 'unknown';
        readonly summary: string;
      }
    | undefined;
  readonly lastAutoReview?:
    | {
        readonly decision: string;
        readonly decisionSource?: string;
        readonly observedAt: string;
      }
    | undefined;
  readonly lifecycleIntegrity: 'confirmed' | 'uncertain';
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastProgressAt?: string | undefined;
  readonly terminalAt?: string | undefined;
  readonly finalResult?: string | undefined;
  readonly latestError?: string | undefined;
  readonly lifecycleDiagnostics?: readonly string[] | undefined;
  readonly desktopMirror: {
    readonly status: 'pending' | 'confirmed' | 'degraded' | 'unsupported';
    readonly name?: string;
    readonly section?: string;
  };
  readonly nextSeq: number;
}

export interface AgentStartInput {
  readonly workspaceId: string;
  readonly relativeCwd?: string | undefined;
  readonly taskTitle: string;
  readonly prompt: string;
  readonly supervisionMode?: SupervisionMode | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly invocationRationale?: string | undefined;
}

export interface AgentListInput {
  readonly workspaceId?: string | undefined;
  readonly status?: AgentStatus | undefined;
  readonly limit?: number | undefined;
}

export interface AgentRefInput {
  readonly agentRef: string;
}

export interface AgentWaitInput extends AgentRefInput {
  readonly afterSeq?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface AgentSendInput extends AgentRefInput {
  readonly message: string;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly invocationRationale?: string | undefined;
}

export interface AgentApprovalInput extends AgentRefInput {
  readonly approvalRequestId: string;
}

export interface AgentController {
  start(input: AgentStartInput): Promise<unknown>;
  list(input: AgentListInput): Promise<unknown>;
  show(input: AgentRefInput): Promise<unknown>;
  wait(input: AgentWaitInput): Promise<unknown>;
  send(input: AgentSendInput): Promise<unknown>;
  approve(input: AgentApprovalInput): Promise<unknown>;
  reject(input: AgentApprovalInput): Promise<unknown>;
  cancel(input: AgentRefInput): Promise<unknown>;
  archive(input: AgentRefInput): Promise<unknown>;
  revokeWorkspace?(workspaceId: string): Promise<void>;
}

export class AgentError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
