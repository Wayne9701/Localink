import type { SecretRef } from '@localink/sdk';

export const SERVICE_IDS = [
  'localink-core',
  'localink-tunnel',
  'localink-recovery',
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];
export type RecoverableServiceId = 'localink-core' | 'localink-tunnel';
export type ServiceReadiness = 'ready' | 'failed' | 'unknown';

export interface InstallationContextInput {
  readonly installPrefix: string;
  readonly localinkExecutablePath: string;
  readonly runtimePath: string;
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly logRoot: string;
  readonly userHome: string;
  readonly launchAgentsDirectory: string;
  readonly uid: number;
}

export interface InstallationContext extends InstallationContextInput {
  readonly launchdDomain: `gui/${number}`;
}

export interface LaunchAgentDefinition {
  readonly serviceId: ServiceId;
  readonly Label: string;
  readonly ProgramArguments: readonly string[];
  readonly WorkingDirectory: string;
  readonly RunAtLoad: boolean;
  readonly KeepAlive: boolean;
  readonly StartInterval?: number;
  readonly StandardOutPath: string;
  readonly StandardErrorPath: string;
  readonly EnvironmentVariables: Readonly<Record<string, string>>;
  readonly Umask: string;
}

export interface LaunchAgentArtifact {
  readonly serviceId: ServiceId;
  readonly label: string;
  readonly destinationPath: string;
  readonly contents: string;
}

export interface LaunchctlCommand {
  readonly command: '/bin/launchctl';
  readonly args: readonly string[];
}

export interface ServiceExit {
  readonly at: string;
  readonly code?: number;
  readonly signal?: string;
}

export interface ServiceStatus {
  readonly serviceId: ServiceId;
  readonly installed: boolean;
  readonly processRunning: boolean;
  readonly pid?: number;
  readonly readiness: ServiceReadiness;
  readonly lastExit?: ServiceExit;
  readonly recentRestarts: number;
  readonly cooldownUntil?: string;
  readonly reasonCodes: readonly string[];
  readonly checkedAt: string;
}

export interface LocalinkServiceTopologyStatus {
  readonly core: ServiceStatus;
  readonly localMcpReadiness: ServiceReadiness;
  readonly tunnel: ServiceStatus;
  readonly tunnelConnected: ServiceReadiness;
  readonly tunnelReady: ServiceReadiness;
  readonly checkedAt: string;
}

export interface TunnelWrapperInput {
  readonly binaryPath: string;
  readonly profileName: string;
  readonly profileDirectory: string;
  readonly workingDirectory: string;
  readonly secretRef: SecretRef;
  readonly baseEnvironment?: Readonly<Record<string, string>>;
}

export interface TunnelLaunchReceipt {
  readonly serviceId: 'localink-tunnel';
  readonly launched: true;
  readonly pid?: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly secretInjected: true;
  readonly injectedEnvironmentKeys: readonly ['CONTROL_PLANE_API_KEY'];
}

export interface RestartEvent {
  readonly serviceId: RecoverableServiceId;
  readonly at: string;
}

export interface RecoveryPolicy {
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly restartWindowMs: number;
  readonly maxAttempts: number;
  readonly cooldownMs: number;
}

export type OperatorIntent =
  | { readonly kind: 'automatic' }
  | {
      readonly kind: 'start' | 'restart' | 'stop';
      readonly serviceId: RecoverableServiceId;
    };

export interface RecoveryInput {
  readonly core: ServiceStatus;
  readonly localMcpReadiness: ServiceReadiness;
  readonly tunnel: ServiceStatus;
  readonly tunnelConnected: ServiceReadiness;
  readonly tunnelReady: ServiceReadiness;
  readonly tunnelAuth: ServiceReadiness;
  readonly coreConfig: 'valid' | 'invalid' | 'unknown';
  readonly tunnelConfig: 'valid' | 'invalid' | 'unknown';
  readonly tunnelSecret: 'available' | 'missing' | 'unknown';
  readonly restartHistory: readonly RestartEvent[];
  readonly now: string;
  readonly policy: RecoveryPolicy;
  readonly operatorIntent: OperatorIntent;
}

export type RecoveryAction =
  | 'no_action'
  | 'start'
  | 'restart'
  | 'stop'
  | 'wait_backoff'
  | 'manual_intervention';

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  readonly serviceId?: RecoverableServiceId;
  readonly reasonCode: string;
  readonly delayMs?: number;
  readonly cooldownUntil?: string;
  readonly suggestedCleanup?: 'remove_stale_pid_or_lock_after_owner_check';
  readonly checkedAt: string;
  readonly oneShot: true;
}

export interface InstallPlan {
  readonly domainTarget: `gui/${number}`;
  readonly artifacts: readonly LaunchAgentArtifact[];
  readonly requiredPermissions: readonly ['user_launch_agent_write'];
  readonly requiresRoot: false;
}

export interface UninstallPlan {
  readonly serviceTargets: readonly string[];
  readonly plistPaths: readonly string[];
  readonly preservePaths: readonly string[];
  readonly preservesUserData: true;
  readonly preservesSecrets: true;
  readonly requiresRoot: false;
}
