import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  LocalinkError,
  type ResolvedWorkspacePath,
  type WorkspaceRecord,
} from '@localink/sdk';
import { nodeErrorCode, wrapIoError } from '../internal/errors.js';

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function normalizeRelativePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new LocalinkError('INVALID_ARGUMENT', 'Relative path is invalid.');
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new LocalinkError(
      'PATH_OUTSIDE_WORKSPACE',
      'Absolute paths are not accepted at the workspace boundary.',
      { relativePath },
    );
  }
  if (relativePath.split(/[\\/]+/u).includes('..')) {
    throw new LocalinkError(
      'PATH_OUTSIDE_WORKSPACE',
      'Parent traversal is not accepted at the workspace boundary.',
      { relativePath },
    );
  }
  const normalized = path.normalize(relativePath);
  return normalized === '.' ? '' : normalized;
}

async function nearestCanonicalPath(candidate: string): Promise<{
  canonical: string;
  exists: boolean;
}> {
  let cursor = candidate;
  const missing: string[] = [];

  for (;;) {
    try {
      await lstat(cursor);
      const canonicalParent = await realpath(cursor);
      return {
        canonical: path.join(canonicalParent, ...missing.reverse()),
        exists: missing.length === 0,
      };
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export class WorkspaceRegistry {
  readonly #records = new Map<string, WorkspaceRecord>();

  async register(name: string, root: string): Promise<WorkspaceRecord> {
    if (name.trim().length === 0 || name.includes('\0')) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Workspace name is required.',
      );
    }
    if (!path.isAbsolute(root)) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Workspace registration requires an absolute host path.',
      );
    }

    try {
      const canonicalRoot = await realpath(root);
      const rootStat = await stat(canonicalRoot);
      if (!rootStat.isDirectory()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Workspace root must be a directory.',
          { root },
        );
      }
      await access(canonicalRoot, constants.R_OK);
      if (
        [...this.#records.values()].some(
          (entry) => entry.root === canonicalRoot,
        )
      ) {
        throw new LocalinkError(
          'ALREADY_EXISTS',
          'Workspace root is already registered.',
        );
      }
      const record: WorkspaceRecord = {
        id: randomUUID(),
        name,
        root: canonicalRoot,
        createdAt: new Date().toISOString(),
      };
      this.#records.set(record.id, record);
      return { ...record };
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') {
        throw new LocalinkError('NOT_FOUND', 'Workspace root does not exist.', {
          root,
        });
      }
      throw wrapIoError('Unable to register workspace.', error);
    }
  }

  async restore(record: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (
      typeof record.id !== 'string' ||
      record.id.length === 0 ||
      record.id.includes('\0') ||
      typeof record.name !== 'string' ||
      record.name.trim().length === 0 ||
      record.name.includes('\0') ||
      typeof record.createdAt !== 'string' ||
      Number.isNaN(Date.parse(record.createdAt))
    ) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Persisted workspace record is invalid.',
      );
    }
    if (!path.isAbsolute(record.root)) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Persisted workspace root must be an absolute host path.',
      );
    }
    if (this.#records.has(record.id)) {
      throw new LocalinkError(
        'ALREADY_EXISTS',
        'Workspace ID is already registered.',
        { workspaceId: record.id },
      );
    }

    try {
      const canonicalRoot = await realpath(record.root);
      const rootStat = await stat(canonicalRoot);
      if (!rootStat.isDirectory()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Workspace root must be a directory.',
          { root: record.root },
        );
      }
      await access(canonicalRoot, constants.R_OK);
      if (
        [...this.#records.values()].some(
          (entry) => entry.root === canonicalRoot,
        )
      ) {
        throw new LocalinkError(
          'ALREADY_EXISTS',
          'Workspace root is already registered.',
        );
      }
      const restored: WorkspaceRecord = {
        id: record.id,
        name: record.name,
        root: canonicalRoot,
        createdAt: record.createdAt,
      };
      this.#records.set(restored.id, restored);
      return { ...restored };
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') {
        throw new LocalinkError('NOT_FOUND', 'Workspace root does not exist.', {
          root: record.root,
        });
      }
      throw wrapIoError('Unable to restore workspace.', error);
    }
  }

  list(): WorkspaceRecord[] {
    return [...this.#records.values()]
      .map((record) => ({ ...record }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  inspect(workspaceId: string): WorkspaceRecord {
    const record = this.#records.get(workspaceId);
    if (record === undefined) {
      throw new LocalinkError(
        'NOT_FOUND',
        'Workspace registration was not found.',
        {
          workspaceId,
        },
      );
    }
    return { ...record };
  }

  remove(workspaceId: string): WorkspaceRecord {
    const record = this.inspect(workspaceId);
    this.#records.delete(workspaceId);
    return record;
  }

  async resolve(
    workspaceId: string,
    relativePath = '',
  ): Promise<ResolvedWorkspacePath> {
    const workspace = this.inspect(workspaceId);
    const normalized = normalizeRelativePath(relativePath);
    const lexical = path.resolve(workspace.root, normalized);
    if (!isWithin(workspace.root, lexical)) {
      throw new LocalinkError(
        'PATH_OUTSIDE_WORKSPACE',
        'Resolved path is outside the workspace.',
        { workspaceId, relativePath },
      );
    }

    try {
      const resolved = await nearestCanonicalPath(lexical);
      if (!isWithin(workspace.root, resolved.canonical)) {
        throw new LocalinkError(
          'SYMLINK_ESCAPE',
          'A symlink resolves outside the workspace.',
          { workspaceId, relativePath },
        );
      }
      return {
        workspaceId,
        relativePath: normalized,
        absolutePath: resolved.canonical,
        exists: resolved.exists,
      };
    } catch (error) {
      throw wrapIoError('Unable to resolve workspace path.', error);
    }
  }

  async resolveCwd(workspaceId: string, cwd = ''): Promise<string> {
    const resolved = await this.resolve(workspaceId, cwd);
    if (!resolved.exists) {
      throw new LocalinkError(
        'NOT_FOUND',
        'Process working directory does not exist.',
        {
          workspaceId,
          cwd,
        },
      );
    }
    try {
      const cwdStat = await stat(resolved.absolutePath);
      if (!cwdStat.isDirectory()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Process working directory must be a directory.',
          { workspaceId, cwd },
        );
      }
      return resolved.absolutePath;
    } catch (error) {
      throw wrapIoError('Unable to inspect process working directory.', error);
    }
  }
}
