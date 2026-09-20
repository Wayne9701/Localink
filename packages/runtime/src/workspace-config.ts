import { LocalinkError, type WorkspaceRecord } from '@localink/sdk';

export const WORKSPACE_SCHEMA_VERSION = 1;

export interface WorkspaceConfig {
  readonly version: typeof WORKSPACE_SCHEMA_VERSION;
  readonly workspaces: WorkspaceRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRecord(value: unknown): WorkspaceRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['id', 'name', 'root', 'createdAt'].includes(key),
    ) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    typeof value.root !== 'string' ||
    value.root.length === 0 ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Workspace config contains an invalid record.',
    );
  }
  return {
    id: value.id,
    name: value.name,
    root: value.root,
    createdAt: value.createdAt,
  };
}

export function validateWorkspaceConfig(value: unknown): WorkspaceConfig {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['version', 'workspaces'].includes(key),
    ) ||
    value.version !== WORKSPACE_SCHEMA_VERSION ||
    !Array.isArray(value.workspaces)
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Workspace config must use schema version 1.',
    );
  }
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    workspaces: value.workspaces.map(validateRecord),
  };
}
