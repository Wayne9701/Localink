export const TESTED_LOCAL_TUNNEL_CLIENT_VERSION =
  '0.0.11+8d55683eeef80bc5e360d95abf4692454fafc615' as const;
export const CONTROL_PLANE_API_KEY_ENV = 'CONTROL_PLANE_API_KEY' as const;
export const DEFAULT_CONTROL_PLANE_BASE_URL = 'https://api.openai.com' as const;
export const DEFAULT_HEALTH_LISTEN_ADDRESS = '127.0.0.1:8080' as const;

export type Compatibility = 'tested' | 'supported' | 'unsupported' | 'unknown';
export type Readiness = 'ready' | 'failed' | 'unknown';

export interface TunnelInstallRequirement {
  readonly required: boolean;
  readonly reasonCode:
    | 'TUNNEL_BINARY_PRESENT'
    | 'TUNNEL_BINARY_MISSING'
    | 'TUNNEL_BINARY_UNUSABLE'
    | 'TUNNEL_VERSION_UNSUPPORTED';
  readonly automaticInstallSupported: false;
}

export interface TunnelBinaryStatus {
  readonly available: boolean;
  readonly binaryPath?: string;
  readonly version?: string;
  readonly compatibility: Compatibility;
  readonly reasonCodes: readonly string[];
  readonly installRequirement: TunnelInstallRequirement;
}

export interface TunnelProfileInput {
  readonly name: string;
  readonly tunnelId: string;
  readonly apiKeyFilePath: string;
  readonly localMcpUrl: string;
  readonly controlPlaneBaseUrl?: string;
  readonly healthListenAddress?: string;
  readonly healthUrlFile?: string;
}

export interface ValidatedTunnelProfile {
  readonly name: string;
  readonly tunnelId: string;
  readonly apiKeyFilePath: string;
  readonly apiKeyFileReference: `file:${string}`;
  readonly localMcpUrl: string;
  readonly controlPlaneBaseUrl: string;
  readonly healthListenAddress: string;
  readonly healthUrlFile?: string;
}

export interface TunnelProfileWriteReceipt {
  readonly profileName: string;
  readonly profilePath: string;
  readonly profileDirectory: string;
  readonly sha256: string;
  readonly replaced: boolean;
  readonly apiKeySource: 'file';
}

export interface TunnelCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly environmentOverrides?: Readonly<Record<string, string>>;
}

export interface DoctorLayerResult {
  readonly profileValid: Readiness;
  readonly tunnelIdPresent: Readiness;
  readonly localMcpConfigured: Readiness;
  readonly localMcpReachable: Readiness;
  readonly controlPlaneAuth: Readiness;
  readonly tunnelConnected: Readiness;
  readonly tunnelReady: Readiness;
  readonly reasonCodes: readonly string[];
}

export interface TunnelStatus {
  readonly binaryAvailable: boolean;
  readonly version?: string;
  readonly versionCompatibility: Compatibility;
  readonly profileValid: Readiness;
  readonly tunnelIdPresent: Readiness;
  readonly localMcpTarget: {
    readonly configured: Readiness;
    readonly reachable: Readiness;
  };
  readonly controlPlaneAuth: Readiness;
  readonly tunnel: {
    readonly connected: Readiness;
    readonly ready: Readiness;
  };
  readonly reasonCodes: readonly string[];
  readonly checkedAt: string;
}
