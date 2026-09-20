import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalinkError } from '@localink/sdk';
import type { WorkspaceRegistry } from '../workspace/workspace-registry.js';

export const GIT_LIMITS = {
  defaultStatusEntries: 200,
  hardStatusEntries: 500,
  defaultDiffBytes: 128 * 1024,
  hardDiffBytes: 256 * 1024,
  defaultLogEntries: 20,
  hardLogEntries: 50,
  hardPatchBytes: 256 * 1024,
  hardPatchFiles: 20,
} as const;

const READ_TIMEOUT_MS = 15_000;
const APPLY_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const TEXT_VALIDATION_BYTES = 8 * 1024 * 1024;

export interface GitRepository {
  readonly workspaceId: string;
  readonly root: string;
  readonly repoPath: string;
}

export interface GitInspectReceipt {
  readonly repoPath: string;
  readonly head: string;
  readonly shortHead: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: false;
  readonly gitVersion?: string;
}

export interface GitStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly kind:
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'untracked'
    | 'conflicted';
}

export interface GitStatusReceipt {
  readonly branch: string | null;
  readonly head: string;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly entries: readonly GitStatusEntry[];
  readonly clean: boolean;
  readonly truncated: boolean;
  readonly total: number;
}

export interface GitDiffReceipt {
  readonly diff: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly scope: 'worktree' | 'staged';
  readonly paths: readonly string[];
}

export interface GitLogEntry {
  readonly hash: string;
  readonly shortHash: string;
  readonly parentHashes: readonly string[];
  readonly authorName: string;
  readonly authoredAt: string;
  readonly subject: string;
}

export interface GitApplyReceipt {
  readonly repoPath: string;
  readonly expectedHead: string;
  readonly head: string;
  readonly affectedFiles: readonly string[];
  readonly verification: {
    readonly verified: true;
    readonly method: 'git apply --check + git diff --check + HEAD read-back';
  };
}

interface GitCommandResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutByteLength: number;
  readonly stderrByteLength: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

interface PatchTarget {
  readonly path: string;
  readonly created: boolean;
}

interface SnapshotEntry {
  readonly target: PatchTarget;
  readonly absolutePath: string;
  readonly backupPath?: string;
  readonly mode?: number;
  readonly atimeMs?: number;
  readonly mtimeMs?: number;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function publicPath(value: string): string {
  return value.split(path.sep).join('/');
}

function assertBound(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      `${label} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function assertRepoRelativePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.split(/[\\/]+/u).includes('..')
  ) {
    throw new LocalinkError(
      'PATH_OUTSIDE_WORKSPACE',
      'Git paths must be repo-relative and may not traverse parents.',
    );
  }
  const normalized = path.normalize(value);
  if (normalized === '.' || normalized.startsWith(`..${path.sep}`)) {
    throw new LocalinkError(
      'PATH_OUTSIDE_WORKSPACE',
      'Git paths must be repo-relative and may not traverse parents.',
    );
  }
  return normalized;
}

function kindFromStatus(indexStatus: string, worktreeStatus: string) {
  const status = `${indexStatus}${worktreeStatus}`;
  if (status.includes('U')) return 'conflicted' as const;
  if (status.includes('R')) return 'renamed' as const;
  if (status.includes('C')) return 'copied' as const;
  if (status.includes('D')) return 'deleted' as const;
  if (status.includes('A')) return 'added' as const;
  return 'modified' as const;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LC_') && value !== undefined) environment[key] = value;
  }
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function parsePatch(patch: string): PatchTarget[] {
  if (
    patch.length === 0 ||
    Buffer.byteLength(patch, 'utf8') > GIT_LIMITS.hardPatchBytes
  ) {
    throw new LocalinkError(
      'SIZE_LIMIT_EXCEEDED',
      'Patch exceeds the allowed size.',
    );
  }
  if (patch.includes('\0')) {
    throw new LocalinkError(
      'BINARY_NOT_SUPPORTED',
      'Binary patches are not supported.',
    );
  }
  const lines = patch.split('\n');
  const targets: PatchTarget[] = [];
  let current:
    | { path: string; oldHeader?: string; newHeader?: string; newFile: boolean }
    | undefined;
  const finalize = (): void => {
    if (current === undefined) return;
    if (current.oldHeader === undefined || current.newHeader === undefined) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Patch file headers are incomplete.',
      );
    }
    if (current.newHeader === '/dev/null') {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Patch deletion is not supported.',
      );
    }
    const created = current.oldHeader === '/dev/null';
    if (created !== current.newFile) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Patch creation metadata is invalid.',
      );
    }
    if (!created && current.oldHeader !== `a/${current.path}`) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Patch source path is invalid.',
      );
    }
    if (current.newHeader !== `b/${current.path}`) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Patch destination path is invalid.',
      );
    }
    targets.push({ path: current.path, created });
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finalize();
      const match = /^diff --git a\/([^\s]+) b\/([^\s]+)$/u.exec(line);
      if (match === null || match[1] !== match[2]) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Patch paths must be matching safe repo-relative paths.',
        );
      }
      const patchPath = assertRepoRelativePath(match[1] ?? '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(patchPath)) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Patch path uses unsupported characters.',
        );
      }
      current = { path: publicPath(patchPath), newFile: false };
      continue;
    }
    if (
      /^(GIT binary patch|Binary files |similarity index |rename (from|to) |copy (from|to) |old mode |new mode |deleted file mode |diff --submodule |Subproject commit )/u.test(
        line,
      ) ||
      /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/u.test(line) ||
      /^new file mode 120000$/u.test(line)
    ) {
      throw new LocalinkError(
        'BINARY_NOT_SUPPORTED',
        'Binary, mode, rename, copy, and submodule patches are not supported.',
      );
    }
    if (current === undefined) continue;
    if (/^new file mode 100(644|755)$/u.test(line)) {
      current.newFile = true;
    } else if (line.startsWith('new file mode ')) {
      throw new LocalinkError(
        'BINARY_NOT_SUPPORTED',
        'Only regular text files may be created.',
      );
    } else if (line.startsWith('--- ')) {
      current.oldHeader = line.slice(4).split('\t', 1)[0] ?? '';
    } else if (line.startsWith('+++ ')) {
      current.newHeader = line.slice(4).split('\t', 1)[0] ?? '';
    }
  }
  finalize();
  if (targets.length === 0 || targets.length > GIT_LIMITS.hardPatchFiles) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      'Patch must affect between 1 and 20 files.',
    );
  }
  if (new Set(targets.map((target) => target.path)).size !== targets.length) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      'Patch may not contain duplicate file entries.',
    );
  }
  return targets;
}

export class GitService {
  readonly #workspaces: WorkspaceRegistry;

  constructor(workspaces: WorkspaceRegistry) {
    this.#workspaces = workspaces;
  }

  async inspect(
    workspaceId: string,
    repoPath = '',
  ): Promise<GitInspectReceipt> {
    const repository = await this.resolveRepository(workspaceId, repoPath);
    const head = await this.#head(repository);
    const branch = await this.#branch(repository);
    const version = await this.#run(repository.root, ['--version']);
    return {
      repoPath: repository.repoPath,
      head,
      shortHead: head.slice(0, 12),
      branch,
      detached: branch === null,
      bare: false,
      ...(version.code === 0
        ? {
            gitVersion: version.stdout
              .toString('utf8')
              .trim()
              .replace(/^git version\s+/u, ''),
          }
        : {}),
    };
  }

  async status(
    workspaceId: string,
    repoPath = '',
    limit: number = GIT_LIMITS.defaultStatusEntries,
  ): Promise<GitStatusReceipt> {
    const boundedLimit = assertBound(
      limit,
      GIT_LIMITS.hardStatusEntries,
      'status limit',
    );
    const repository = await this.resolveRepository(workspaceId, repoPath);
    const result = await this.#mustRun(repository.root, [
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
    ]);
    const fields = result.stdout.toString('utf8').split('\0');
    let branch: string | null = null;
    let head = '';
    let upstream: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    const entries: GitStatusEntry[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index] ?? '';
      if (field.length === 0) continue;
      if (field.startsWith('# branch.oid ')) {
        head = field.slice('# branch.oid '.length);
      } else if (field.startsWith('# branch.head ')) {
        const value = field.slice('# branch.head '.length);
        branch = value === '(detached)' ? null : value;
      } else if (field.startsWith('# branch.upstream ')) {
        upstream = field.slice('# branch.upstream '.length);
      } else if (field.startsWith('# branch.ab ')) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(field);
        if (match !== null) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      } else if (field.startsWith('? ')) {
        entries.push({
          path: publicPath(assertRepoRelativePath(field.slice(2))),
          indexStatus: '?',
          worktreeStatus: '?',
          kind: 'untracked',
        });
      } else if (field.startsWith('u ')) {
        const pieces = field.split(' ');
        const status = pieces[1] ?? 'UU';
        const entryPath = pieces.slice(10).join(' ');
        entries.push({
          path: publicPath(assertRepoRelativePath(entryPath)),
          indexStatus: status[0] ?? 'U',
          worktreeStatus: status[1] ?? 'U',
          kind: 'conflicted',
        });
      } else if (field.startsWith('1 ') || field.startsWith('2 ')) {
        const pieces = field.split(' ');
        const status = pieces[1] ?? '  ';
        const isRename = field.startsWith('2 ');
        const entryPath = pieces.slice(isRename ? 9 : 8).join(' ');
        const entry: GitStatusEntry = {
          path: publicPath(assertRepoRelativePath(entryPath)),
          indexStatus: status[0] ?? ' ',
          worktreeStatus: status[1] ?? ' ',
          kind: kindFromStatus(status[0] ?? ' ', status[1] ?? ' '),
          ...(isRename
            ? (() => {
                const originalPath = fields[index + 1];
                if (originalPath === undefined || originalPath.length === 0) {
                  throw new LocalinkError(
                    'IO_ERROR',
                    'Git status rename record was incomplete.',
                  );
                }
                return {
                  originalPath: publicPath(
                    assertRepoRelativePath(originalPath),
                  ),
                };
              })()
            : {}),
        };
        if (isRename) {
          index += 1;
        }
        entries.push(entry);
      }
    }
    return {
      branch,
      head,
      ...(upstream === undefined ? {} : { upstream }),
      ...(ahead === undefined ? {} : { ahead }),
      ...(behind === undefined ? {} : { behind }),
      entries: entries.slice(0, boundedLimit),
      clean: entries.length === 0,
      truncated: result.stdoutTruncated || entries.length > boundedLimit,
      total: entries.length,
    };
  }

  async diff(input: {
    workspaceId: string;
    repoPath?: string;
    scope: 'worktree' | 'staged';
    paths?: readonly string[];
    contextLines?: number;
    maxBytes?: number;
  }): Promise<GitDiffReceipt> {
    const repository = await this.resolveRepository(
      input.workspaceId,
      input.repoPath ?? '',
    );
    const contextLines = input.contextLines ?? 3;
    if (
      !Number.isInteger(contextLines) ||
      contextLines < 0 ||
      contextLines > 20
    ) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'contextLines must be between 0 and 20.',
      );
    }
    const maxBytes = input.maxBytes ?? GIT_LIMITS.defaultDiffBytes;
    assertBound(maxBytes, GIT_LIMITS.hardDiffBytes, 'diff maxBytes');
    const paths = (input.paths ?? []).map((entry) =>
      publicPath(assertRepoRelativePath(entry)),
    );
    if (paths.length > 20) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Diff supports at most 20 paths.',
      );
    }
    const result = await this.#run(repository.root, [
      'diff',
      ...(input.scope === 'staged' ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-color',
      `--unified=${contextLines}`,
      '--',
      ...paths,
    ]);
    if (result.code !== 0) {
      throw new LocalinkError('IO_ERROR', 'Git diff failed.');
    }
    const captured = result.stdout.subarray(0, maxBytes);
    const raw = captured.toString('utf8');
    const binary =
      raw.includes('GIT binary patch') || raw.includes('Binary files ');
    return {
      diff: binary ? 'Binary diff omitted.\n' : raw,
      byteLength: result.stdoutByteLength,
      truncated: result.stdoutTruncated || result.stdoutByteLength > maxBytes,
      binary,
      scope: input.scope,
      paths,
    };
  }

  async log(
    workspaceId: string,
    repoPath = '',
    limit: number = GIT_LIMITS.defaultLogEntries,
  ): Promise<readonly GitLogEntry[]> {
    const boundedLimit = assertBound(
      limit,
      GIT_LIMITS.hardLogEntries,
      'log limit',
    );
    const repository = await this.resolveRepository(workspaceId, repoPath);
    const result = await this.#mustRun(repository.root, [
      'log',
      '--no-decorate',
      `--max-count=${boundedLimit}`,
      '--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%s%x00',
      'HEAD',
    ]);
    const fields = result.stdout.toString('utf8').split('\0');
    const commits: GitLogEntry[] = [];
    for (let index = 0; index + 5 < fields.length; index += 6) {
      if (fields[index]?.length === 0) continue;
      commits.push({
        hash: fields[index] ?? '',
        shortHash: fields[index + 1] ?? '',
        parentHashes: (fields[index + 2] ?? '').split(' ').filter(Boolean),
        authorName: fields[index + 3] ?? '',
        authoredAt: fields[index + 4] ?? '',
        subject: fields[index + 5] ?? '',
      });
    }
    return commits;
  }

  async applyPatch(input: {
    workspaceId: string;
    repoPath?: string;
    patch: string;
    expectedHead: string;
  }): Promise<GitApplyReceipt> {
    if (!/^[a-f0-9]{40,64}$/u.test(input.expectedHead)) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'expectedHead must be a full Git object ID.',
      );
    }
    const repository = await this.resolveRepository(
      input.workspaceId,
      input.repoPath ?? '',
    );
    const currentHead = await this.#head(repository);
    if (currentHead !== input.expectedHead) {
      throw new LocalinkError(
        'STALE_PRECONDITION',
        'Git HEAD precondition did not match.',
      );
    }
    const targets = parsePatch(input.patch);
    const snapshots = await this.#snapshot(repository, targets);
    try {
      await this.#mustRun(
        repository.root,
        ['apply', '--check'],
        input.patch,
        APPLY_TIMEOUT_MS,
      );
      try {
        await this.#mustRun(
          repository.root,
          ['apply'],
          input.patch,
          APPLY_TIMEOUT_MS,
        );
      } catch (error) {
        await this.#restore(snapshots);
        throw error;
      }
      const whitespace = await this.#run(repository.root, ['diff', '--check']);
      const headAfter = await this.#head(repository);
      if (whitespace.code !== 0 || headAfter !== currentHead) {
        await this.#restore(snapshots);
        throw new LocalinkError(
          'VERIFICATION_REQUIRED',
          'Git patch post-verification failed.',
        );
      }
      return {
        repoPath: repository.repoPath,
        expectedHead: currentHead,
        head: headAfter,
        affectedFiles: targets.map((target) => target.path),
        verification: {
          verified: true,
          method: 'git apply --check + git diff --check + HEAD read-back',
        },
      };
    } finally {
      await Promise.all(snapshots.map((snapshot) => snapshot.cleanup()));
    }
  }

  async resolveRepository(
    workspaceId: string,
    repoPath = '',
  ): Promise<GitRepository> {
    const workspace = this.#workspaces.inspect(workspaceId);
    const requested = await this.#workspaces.resolve(workspaceId, repoPath);
    if (!requested.exists) {
      throw new LocalinkError(
        'NOT_FOUND',
        'Git repository path does not exist.',
      );
    }
    const requestedStat = await stat(requested.absolutePath);
    if (!requestedStat.isDirectory()) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Git repository path must be a directory.',
      );
    }
    const topLevel = await this.#run(requested.absolutePath, [
      'rev-parse',
      '--show-toplevel',
    ]);
    if (topLevel.code !== 0) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Path is not inside a non-bare Git repository.',
      );
    }
    const root = await realpath(topLevel.stdout.toString('utf8').trim());
    if (!isWithin(workspace.root, root)) {
      throw new LocalinkError(
        'PATH_OUTSIDE_WORKSPACE',
        'Git repository root is outside the workspace.',
      );
    }
    const bare = await this.#mustRun(root, [
      'rev-parse',
      '--is-bare-repository',
    ]);
    if (bare.stdout.toString('utf8').trim() !== 'false') {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Bare Git repositories are not supported.',
      );
    }
    return {
      workspaceId,
      root,
      repoPath: publicPath(path.relative(workspace.root, root)),
    };
  }

  async #head(repository: GitRepository): Promise<string> {
    return (
      await this.#mustRun(repository.root, ['rev-parse', '--verify', 'HEAD'])
    ).stdout
      .toString('utf8')
      .trim();
  }

  async #branch(repository: GitRepository): Promise<string | null> {
    const result = await this.#run(repository.root, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    if (result.code === 1) return null;
    if (result.code !== 0)
      throw new LocalinkError('IO_ERROR', 'Unable to inspect Git branch.');
    return result.stdout.toString('utf8').trim();
  }

  async #snapshot(repository: GitRepository, targets: readonly PatchTarget[]) {
    const directory = path.join(
      tmpdir(),
      `localink-git-rollback-${randomUUID()}`,
    );
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const snapshots: SnapshotEntry[] = [];
    try {
      for (const target of targets) {
        const absolutePath = path.resolve(repository.root, target.path);
        if (!isWithin(repository.root, absolutePath)) {
          throw new LocalinkError(
            'PATH_OUTSIDE_WORKSPACE',
            'Patch path escapes the repository.',
          );
        }
        if (target.created) {
          try {
            await lstat(absolutePath);
            throw new LocalinkError(
              'ALREADY_EXISTS',
              'New patch target already exists.',
            );
          } catch (error) {
            if (error instanceof LocalinkError) throw error;
            const parent = await realpath(path.dirname(absolutePath));
            if (!isWithin(repository.root, parent)) {
              throw new LocalinkError(
                'SYMLINK_ESCAPE',
                'Patch parent escapes the repository.',
              );
            }
          }
          snapshots.push({ target, absolutePath });
          continue;
        }
        const fileStat = await lstat(absolutePath);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          throw new LocalinkError(
            'BINARY_NOT_SUPPORTED',
            'Patch targets must be existing regular text files.',
          );
        }
        if (fileStat.size > TEXT_VALIDATION_BYTES) {
          throw new LocalinkError(
            'SIZE_LIMIT_EXCEEDED',
            'Patch target exceeds the text safety bound.',
          );
        }
        const content = await readFile(absolutePath);
        if (content.includes(0)) {
          throw new LocalinkError(
            'BINARY_NOT_SUPPORTED',
            'Patch targets must be UTF-8 text files.',
          );
        }
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(content);
        } catch {
          throw new LocalinkError(
            'BINARY_NOT_SUPPORTED',
            'Patch targets must be UTF-8 text files.',
          );
        }
        const backupPath = path.join(directory, String(snapshots.length));
        await copyFile(absolutePath, backupPath);
        snapshots.push({
          target,
          absolutePath,
          backupPath,
          mode: fileStat.mode,
          atimeMs: fileStat.atimeMs,
          mtimeMs: fileStat.mtimeMs,
        });
      }
      return snapshots.map((entry) => ({
        ...entry,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      }));
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async #restore(
    snapshots: readonly (SnapshotEntry & { cleanup: () => Promise<void> })[],
  ): Promise<void> {
    for (const snapshot of snapshots) {
      if (snapshot.target.created) {
        const targetStat = await lstat(snapshot.absolutePath).catch(
          () => undefined,
        );
        if (targetStat !== undefined) {
          if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
            throw new LocalinkError(
              'IO_ERROR',
              'Git patch rollback could not safely remove a created path.',
            );
          }
          await unlink(snapshot.absolutePath);
        }
      } else if (snapshot.backupPath !== undefined) {
        await copyFile(snapshot.backupPath, snapshot.absolutePath);
        await chmod(snapshot.absolutePath, snapshot.mode ?? 0o600);
        if (snapshot.atimeMs !== undefined && snapshot.mtimeMs !== undefined) {
          await utimes(
            snapshot.absolutePath,
            snapshot.atimeMs / 1000,
            snapshot.mtimeMs / 1000,
          );
        }
      }
    }
  }

  async #mustRun(
    cwd: string,
    args: readonly string[],
    input?: string,
    timeoutMs = READ_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    const result = await this.#run(cwd, args, input, timeoutMs);
    if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      throw new LocalinkError(
        'IO_ERROR',
        'Git operation failed or exceeded its output bound.',
      );
    }
    return result;
  }

  #run(
    cwd: string,
    args: readonly string[],
    input?: string,
    timeoutMs = READ_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'git',
        ['--no-pager', '-c', 'color.ui=false', ...args],
        {
          cwd,
          env: sanitizedEnvironment(),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      const append = (chunks: Buffer[], chunk: Buffer, current: number) => {
        const remaining = GIT_OUTPUT_BYTES - current;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => {
        append(stdout, chunk, stdoutBytes);
        stdoutBytes += chunk.byteLength;
        stdoutTruncated ||= stdoutBytes > GIT_OUTPUT_BYTES;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        append(stderr, chunk, stderrBytes);
        stderrBytes += chunk.byteLength;
        stderrTruncated ||= stderrBytes > GIT_OUTPUT_BYTES;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new LocalinkError('IO_ERROR', 'Git operation timed out.'));
          return;
        }
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          stdoutByteLength: stdoutBytes,
          stderrByteLength: stderrBytes,
          stdoutTruncated,
          stderrTruncated,
        });
      });
      child.stdin.end(input);
    });
  }
}
