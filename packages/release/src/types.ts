export const RELEASE_MANIFEST_SCHEMA = 1 as const;

export interface ReleasePayloadFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: number;
}

export interface ReleaseManifest {
  readonly schemaVersion: typeof RELEASE_MANIFEST_SCHEMA;
  readonly product: 'localink';
  readonly version: string;
  readonly releaseId: string;
  readonly sourceCommit: string;
  readonly builtAt: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly requiredNodeMajor: number;
  readonly dependencyMode: 'packaged-production';
  readonly requiredTunnelClient: '0.0.14';
  readonly entrypoint: string;
  readonly files: readonly ReleasePayloadFile[];
}

export interface BuildReleaseInput {
  readonly sourceRoot: string;
  readonly artifactRoot: string;
  readonly releaseId: string;
  readonly sourceCommit: string;
  readonly version: string;
  readonly builtAt?: string;
}

export interface ReleaseLayout {
  readonly root: string;
  readonly appRoot: string;
  readonly releasesRoot: string;
  readonly stagingRoot: string;
  readonly currentPointer: string;
  readonly previousPointer: string;
  readonly launcherPath: string;
}

export interface ReleaseStatus {
  readonly current?: string;
  readonly previous?: string;
  readonly releases: readonly string[];
}

export type ReleaseOperationStatus =
  | 'activated'
  | 'rolled_back'
  | 'failed_before_switch'
  | 'failed_rolled_back'
  | 'failed_safe_stop';

export interface ReleaseReceipt {
  readonly operation: 'install' | 'rollback';
  readonly status: ReleaseOperationStatus;
  readonly releaseId: string;
  readonly previousReleaseId?: string;
  readonly pointerSwitched: boolean;
  readonly servicesVerified: boolean;
  readonly statePreserved: true;
  readonly configPreserved: true;
  readonly secretsPreserved: true;
  readonly networkRequiredForRollback: false;
  readonly reasonCode?: string;
}

export interface ReleaseActivationHooks {
  readonly beforeSwitch?: (
    releasePath: string,
    manifest: ReleaseManifest,
  ) => Promise<void>;
  readonly activate?: (
    releasePath: string,
    manifest: ReleaseManifest,
  ) => Promise<void>;
  readonly restorePrior?: () => Promise<void>;
  readonly safeStop?: () => Promise<void>;
}
