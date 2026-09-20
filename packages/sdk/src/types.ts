export interface WorkspaceRecord {
  id: string;
  name: string;
  root: string;
  createdAt: string;
}

export interface ResolvedWorkspacePath {
  workspaceId: string;
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

export interface FileEntry {
  relativePath: string;
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}

export interface FileListReceipt {
  entries: FileEntry[];
  truncated: boolean;
  limit: number;
}

export interface FileTextReceipt {
  relativePath: string;
  text: string;
  byteLength: number;
  sha256: string;
  truncated: false;
}

export interface BinaryMetadataReceipt {
  relativePath: string;
  byteLength: number;
  sha256: string;
  binary: boolean;
}

export interface FileWriteReceipt {
  relativePath: string;
  byteLength: number;
  sha256: string;
  previousSha256?: string;
  occurrences?: number;
}

export interface FileTransferReceipt {
  source: string;
  destination: string;
  byteLength: number;
  sha256: string;
}

export interface ArchiveReceipt {
  workspaceId: string;
  originalRelativePath: string;
  archivePath: string;
  byteLength: number;
  sha256: string;
  movedAt: string;
  crossDeviceFallback: boolean;
}

export interface SearchMatch {
  relativePath: string;
  line?: number;
  preview?: string;
}

export interface SearchReceipt {
  matches: SearchMatch[];
  truncated: boolean;
  scannedEntries: number;
  skippedBinary: number;
  skippedOversize: number;
}

export type ProcessState = 'running' | 'exited' | 'stopped' | 'failed';

export interface ProcessOutput {
  text: string;
  byteLength: number;
  truncated: boolean;
}

export interface ProcessReceipt {
  processId: string;
  hostPid?: number;
  startedAt: string;
  endedAt?: string;
  cwd: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  stdout: ProcessOutput;
  stderr: ProcessOutput;
  state: ProcessState;
}

export interface ExecInput {
  command: string;
  args?: string[];
  workspaceId: string;
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface StartInput extends ExecInput {
  killOnTimeout?: boolean;
}

export interface StopInput {
  processId: string;
  graceMs?: number;
  forceKill?: boolean;
}

export interface StatePaths {
  root: string;
  config: string;
  state: string;
  cache: string;
  logs: string;
  archive: string;
}

export interface VersionMetadata {
  version: string;
  phase: '1A-1' | '1A-2';
}
