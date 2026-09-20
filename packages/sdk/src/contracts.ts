export const CONTRACT_VERSION_V1 = '1' as const;

export interface SchemaReference {
  readonly kind: 'inline' | 'reference';
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly reference?: string;
}

export interface ModuleManifest {
  readonly contractVersion: typeof CONTRACT_VERSION_V1;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly runtime: {
    readonly apiVersion: typeof CONTRACT_VERSION_V1;
    readonly node?: string;
  };
  readonly dependencies?: readonly string[];
  readonly configSchema?: SchemaReference;
  readonly authProviderId?: string;
  readonly capabilityIds?: readonly string[];
  readonly publicSemanticIds?: readonly string[];
}

export type ModuleState = 'registered' | 'enabled' | 'disabled' | 'error';

export type ModuleHealthStatus =
  'healthy' | 'degraded' | 'unhealthy' | 'disabled';

export interface ModuleHealthResult {
  readonly moduleId: string;
  readonly status: ModuleHealthStatus;
  readonly checkedAt: string;
  readonly reasonCode?: string;
  readonly message?: string;
}

export interface ModuleLifecycleContext {
  readonly moduleId: string;
}

export interface ModuleDefinition {
  readonly manifest: ModuleManifest;
  readonly initialize?: (context: ModuleLifecycleContext) => Promise<void>;
  readonly enable?: (context: ModuleLifecycleContext) => Promise<void>;
  readonly disable?: (context: ModuleLifecycleContext) => Promise<void>;
  readonly health?: (
    context: ModuleLifecycleContext,
  ) => Promise<Omit<ModuleHealthResult, 'moduleId' | 'checkedAt'>>;
}

export interface ModuleDescriptor {
  readonly manifest: ModuleManifest;
  readonly state: ModuleState;
  readonly initialized: boolean;
  readonly failure?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ModuleLifecycleReceipt {
  readonly moduleId: string;
  readonly operation: 'register' | 'enable' | 'disable';
  readonly ok: boolean;
  readonly state: ModuleState;
  readonly reasonCode: string;
  readonly message: string;
}

export type AuthState = 'not_configured' | 'signed_out' | 'ready' | 'degraded';

export interface IdentitySummary {
  readonly id: string;
  readonly type: string;
  readonly displayName?: string;
}

export interface ScopeSummary {
  readonly granted: readonly string[];
  readonly required: readonly string[];
  readonly missing: readonly string[];
}

export interface SecretRef {
  readonly provider: string;
  readonly key: string;
  readonly namespace?: string;
}

export interface AuthStatus {
  readonly providerId: string;
  readonly state: AuthState;
  readonly identity?: IdentitySummary;
  readonly scopes: ScopeSummary;
  readonly refreshReady: boolean;
  readonly credentialRef?: SecretRef;
}

export interface AuthStatusRequest {
  readonly requiredScopes?: readonly string[];
}

export interface AuthProvider {
  readonly id: string;
  status(request?: AuthStatusRequest): Promise<AuthStatus>;
  setup(): Promise<AuthStatus>;
  login(): Promise<AuthStatus>;
  refresh(): Promise<AuthStatus>;
  logout(): Promise<AuthStatus>;
}

export type RiskTier = 0 | 1 | 2 | 3;
export type OperationClass = 'read' | 'write';
export type PostVerifyRequirement = 'none' | 'optional' | 'required';

export interface CapabilityDescriptor {
  readonly contractVersion: typeof CONTRACT_VERSION_V1;
  readonly id: string;
  readonly moduleId: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: SchemaReference;
  readonly outputSummary: string;
  readonly operationClass: OperationClass;
  readonly requiredIdentity?: string;
  readonly requiredScopes: readonly string[];
  readonly riskTier: RiskTier;
  readonly reversible: boolean;
  readonly supportsPrecondition: boolean;
  readonly postVerify: PostVerifyRequirement;
  readonly publicSemantic: boolean;
}

export type PolicyProfileName = 'open' | 'balanced' | 'strict';
export type PolicyAction = 'allow' | 'confirm' | 'deny';

export interface PolicyProfile {
  readonly name: PolicyProfileName;
  readonly decisions: Readonly<Record<RiskTier, PolicyAction>>;
}

export interface WorkspacePolicyOverride {
  readonly decisions?: Readonly<Partial<Record<RiskTier, PolicyAction>>>;
}

export interface PolicyDecision {
  readonly action: PolicyAction;
  readonly profile: PolicyProfileName;
  readonly tier: RiskTier;
  readonly reason: {
    readonly code: string;
    readonly message: string;
  };
  readonly workspaceOverrideApplied: boolean;
}

export interface CapabilityInvokeContext {
  readonly workspaceId?: string;
  readonly policyProfile: PolicyProfileName;
  readonly workspacePolicyOverride?: WorkspacePolicyOverride;
  readonly identity?: IdentitySummary;
  readonly grantedScopes?: readonly string[];
  readonly correlationId?: string;
}

export interface VerificationReceipt {
  readonly verified: boolean;
  readonly method: string;
  readonly summary?: string;
}

export interface CapabilityHandlerResult {
  readonly output: unknown;
  readonly verification?: VerificationReceipt;
}

export type CapabilityHandler = (
  input: unknown,
  context: CapabilityInvokeContext,
) => Promise<CapabilityHandlerResult>;

export interface CapabilityAvailability {
  readonly capabilityId: string;
  readonly available: boolean;
  readonly reasons: readonly string[];
}

export interface CapabilityInvokeReceipt {
  readonly capabilityId: string;
  readonly status: 'executed' | 'confirmation_required' | 'denied';
  readonly policy: PolicyDecision;
  readonly output?: unknown;
  readonly verification?: VerificationReceipt;
}

export interface SecretValueHandle {
  reveal(): string;
  toJSON(): '[REDACTED]';
}

export interface SecretMutationReceipt {
  readonly ref: SecretRef;
  readonly operation: 'set' | 'delete';
  readonly changed: boolean;
}

export interface SecretProvider {
  readonly id: string;
  get(ref: SecretRef): Promise<SecretValueHandle | undefined>;
  set(ref: SecretRef, value: string): Promise<SecretMutationReceipt>;
  delete(ref: SecretRef): Promise<SecretMutationReceipt>;
}

export interface SkillManifest {
  readonly contractVersion: typeof CONTRACT_VERSION_V1;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly entry: 'SKILL.md';
  readonly tags?: readonly string[];
  readonly assets?: readonly string[];
  readonly scripts?: readonly string[];
}

export interface SkillDescriptor {
  readonly manifest: SkillManifest;
  readonly location: string;
  readonly contentByteLength: number;
}

export interface SkillReadReceipt extends SkillDescriptor {
  readonly content: string;
  readonly returnedByteLength: number;
  readonly truncated: boolean;
}
