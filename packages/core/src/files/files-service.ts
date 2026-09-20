import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename as renamePath,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  LocalinkError,
  type ArchiveReceipt,
  type BinaryMetadataReceipt,
  type FileEntry,
  type FileListReceipt,
  type FileTextReceipt,
  type FileTransferReceipt,
  type FileWriteReceipt,
  type SearchMatch,
  type SearchReceipt,
  type StatePaths,
} from '@localink/sdk';
import type { WorkspaceRegistry } from '../workspace/workspace-registry.js';
import { nodeErrorCode, wrapIoError } from '../internal/errors.js';

export const FILE_LIMITS = {
  defaultTextBytes: 200 * 1024,
  hardTextBytes: 2 * 1024 * 1024,
  defaultListEntries: 200,
  hardListEntries: 1000,
  defaultSearchMatches: 100,
  hardSearchMatches: 200,
  hardSearchEntries: 10_000,
  hardBatchItems: 100,
} as const;

function relativeJoin(parent: string, child: string): string {
  return parent.length === 0 ? child : path.join(parent, child);
}

function kindOf(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileEntry['kind'] {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

function assertPositiveBound(
  value: number,
  hardMax: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value <= 0 || value > hardMax) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      `${label} must be a positive integer no greater than ${hardMax}.`,
      { value, hardMax },
    );
  }
  return value;
}

function ensureText(buffer: Buffer, relativePath: string): string {
  if (buffer.includes(0)) {
    throw new LocalinkError(
      'BINARY_NOT_SUPPORTED',
      'Binary content cannot be read as text.',
      { relativePath },
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new LocalinkError(
      'BINARY_NOT_SUPPORTED',
      'Content is not valid UTF-8 text.',
      { relativePath },
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function atomicWrite(
  absolutePath: string,
  content: Buffer,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renamePath(temporaryPath, absolutePath);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function countOccurrences(text: string, needle: string): Promise<number> {
  if (needle.length === 0) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      'expectedText must not be empty.',
    );
  }
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

export interface PreciseEditInput {
  workspaceId: string;
  relativePath: string;
  expectedText: string;
  replacementText: string;
  expectedSha256?: string;
  expectedOccurrences?: number;
}

export interface SearchOptions {
  relativePath?: string;
  maxMatches?: number;
}

export class FilesService {
  readonly #workspaces: WorkspaceRegistry;
  readonly #statePaths: StatePaths;

  constructor(workspaces: WorkspaceRegistry, statePaths: StatePaths) {
    this.#workspaces = workspaces;
    this.#statePaths = statePaths;
  }

  async list(
    workspaceId: string,
    relativePath = '',
    limit: number = FILE_LIMITS.defaultListEntries,
  ): Promise<FileListReceipt> {
    const boundedLimit = assertPositiveBound(
      limit,
      FILE_LIMITS.hardListEntries,
      'list limit',
    );
    const resolved = await this.#workspaces.resolve(workspaceId, relativePath);
    if (!resolved.exists) {
      throw new LocalinkError('NOT_FOUND', 'Directory does not exist.', {
        relativePath,
      });
    }
    try {
      const directoryStat = await stat(resolved.absolutePath);
      if (!directoryStat.isDirectory()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'List target must be a directory.',
          { relativePath },
        );
      }
      const directoryEntries = await readdir(resolved.absolutePath, {
        withFileTypes: true,
      });
      const selected = directoryEntries
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, boundedLimit);
      const entries: FileEntry[] = [];
      for (const directoryEntry of selected) {
        const childRelative = relativeJoin(relativePath, directoryEntry.name);
        const child = await this.#workspaces.resolve(
          workspaceId,
          childRelative,
        );
        const childStat = await stat(child.absolutePath);
        entries.push({
          relativePath: childRelative,
          name: directoryEntry.name,
          kind: kindOf(directoryEntry),
          size: childStat.size,
          modifiedAt: childStat.mtime.toISOString(),
        });
      }
      return {
        entries,
        truncated: directoryEntries.length > boundedLimit,
        limit: boundedLimit,
      };
    } catch (error) {
      throw wrapIoError('Unable to list directory.', error);
    }
  }

  async inspect(workspaceId: string, relativePath: string): Promise<FileEntry> {
    const resolved = await this.#workspaces.resolve(workspaceId, relativePath);
    if (!resolved.exists) {
      throw new LocalinkError('NOT_FOUND', 'Path does not exist.', {
        relativePath,
      });
    }
    try {
      const entryStat = await stat(resolved.absolutePath);
      return {
        relativePath,
        name: path.basename(relativePath),
        kind: kindOf(entryStat),
        size: entryStat.size,
        modifiedAt: entryStat.mtime.toISOString(),
      };
    } catch (error) {
      throw wrapIoError('Unable to inspect path.', error);
    }
  }

  async readText(
    workspaceId: string,
    relativePath: string,
    maxBytes: number = FILE_LIMITS.defaultTextBytes,
  ): Promise<FileTextReceipt> {
    const boundedMax = assertPositiveBound(
      maxBytes,
      FILE_LIMITS.hardTextBytes,
      'read maxBytes',
    );
    const resolved = await this.#workspaces.resolve(workspaceId, relativePath);
    if (!resolved.exists) {
      throw new LocalinkError('NOT_FOUND', 'File does not exist.', {
        relativePath,
      });
    }
    try {
      const fileStat = await stat(resolved.absolutePath);
      if (!fileStat.isFile()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Read target must be a file.',
        );
      }
      if (fileStat.size > boundedMax) {
        throw new LocalinkError(
          'SIZE_LIMIT_EXCEEDED',
          'Text file exceeds the requested read bound.',
          { relativePath, byteLength: fileStat.size, maxBytes: boundedMax },
        );
      }
      const buffer = await readFile(resolved.absolutePath);
      return {
        relativePath,
        text: ensureText(buffer, relativePath),
        byteLength: buffer.byteLength,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        truncated: false,
      };
    } catch (error) {
      throw wrapIoError('Unable to read text file.', error);
    }
  }

  async inspectBinary(
    workspaceId: string,
    relativePath: string,
  ): Promise<BinaryMetadataReceipt> {
    const resolved = await this.#workspaces.resolve(workspaceId, relativePath);
    if (!resolved.exists) {
      throw new LocalinkError('NOT_FOUND', 'File does not exist.', {
        relativePath,
      });
    }
    try {
      const fileStat = await stat(resolved.absolutePath);
      if (!fileStat.isFile()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Binary metadata target must be a file.',
        );
      }
      const handle = await open(resolved.absolutePath, 'r');
      const sample = Buffer.alloc(Math.min(8192, fileStat.size));
      try {
        await handle.read(sample, 0, sample.byteLength, 0);
      } finally {
        await handle.close();
      }
      let binary = sample.includes(0);
      if (!binary) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(sample);
        } catch {
          binary = true;
        }
      }
      return {
        relativePath,
        byteLength: fileStat.size,
        sha256: await hashFile(resolved.absolutePath),
        binary,
      };
    } catch (error) {
      throw wrapIoError('Unable to inspect binary metadata.', error);
    }
  }

  async createText(
    workspaceId: string,
    relativePath: string,
    text: string,
  ): Promise<FileWriteReceipt> {
    const content = Buffer.from(text, 'utf8');
    this.#assertWriteSize(content);
    const destination = await this.#resolveWriteDestination(
      workspaceId,
      relativePath,
    );
    if (destination.exists) {
      throw new LocalinkError('ALREADY_EXISTS', 'Destination already exists.', {
        relativePath,
      });
    }
    try {
      await atomicWrite(destination.absolutePath, content);
      return this.#writeReceipt(relativePath, content);
    } catch (error) {
      throw wrapIoError('Unable to create text file.', error);
    }
  }

  async replaceTextAtomic(
    workspaceId: string,
    relativePath: string,
    text: string,
    expectedSha256?: string,
  ): Promise<FileWriteReceipt> {
    const content = Buffer.from(text, 'utf8');
    this.#assertWriteSize(content);
    const destination = await this.#resolveWriteDestination(
      workspaceId,
      relativePath,
    );
    if (!destination.exists) {
      throw new LocalinkError('NOT_FOUND', 'Destination does not exist.', {
        relativePath,
      });
    }
    const previousSha256 = await hashFile(destination.absolutePath);
    if (expectedSha256 !== undefined && expectedSha256 !== previousSha256) {
      throw new LocalinkError(
        'STALE_PRECONDITION',
        'File changed before atomic replacement; no write was performed.',
        { expected: expectedSha256, actual: previousSha256 },
      );
    }
    try {
      await atomicWrite(destination.absolutePath, content);
      return {
        ...this.#writeReceipt(relativePath, content),
        previousSha256,
      };
    } catch (error) {
      throw wrapIoError('Unable to atomically replace text file.', error);
    }
  }

  async preciseEdit(input: PreciseEditInput): Promise<FileWriteReceipt> {
    const current = await this.readText(
      input.workspaceId,
      input.relativePath,
      FILE_LIMITS.hardTextBytes,
    );
    if (
      input.expectedSha256 !== undefined &&
      input.expectedSha256 !== current.sha256
    ) {
      throw new LocalinkError(
        'STALE_PRECONDITION',
        'File hash does not match expectedSha256; no write was performed.',
        { expected: input.expectedSha256, actual: current.sha256 },
      );
    }
    const occurrences = await countOccurrences(
      current.text,
      input.expectedText,
    );
    const expectedOccurrences = input.expectedOccurrences ?? 1;
    if (occurrences !== expectedOccurrences) {
      throw new LocalinkError(
        'EXPECTED_TEXT_MISMATCH',
        'Expected text occurrence count does not match; no write was performed.',
        { expectedOccurrences, actualOccurrences: occurrences },
      );
    }
    const updated = current.text
      .split(input.expectedText)
      .join(input.replacementText);
    const receipt = await this.replaceTextAtomic(
      input.workspaceId,
      input.relativePath,
      updated,
      current.sha256,
    );
    return { ...receipt, occurrences };
  }

  async sha256(workspaceId: string, relativePath: string): Promise<string> {
    const resolved = await this.#workspaces.resolve(workspaceId, relativePath);
    if (!resolved.exists) {
      throw new LocalinkError('NOT_FOUND', 'File does not exist.', {
        relativePath,
      });
    }
    try {
      const fileStat = await stat(resolved.absolutePath);
      if (!fileStat.isFile()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Hash target must be a file.',
        );
      }
      return await hashFile(resolved.absolutePath);
    } catch (error) {
      throw wrapIoError('Unable to hash file.', error);
    }
  }

  async copy(
    workspaceId: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ): Promise<FileTransferReceipt> {
    const source = await this.#workspaces.resolve(
      workspaceId,
      sourceRelativePath,
    );
    if (!source.exists) {
      throw new LocalinkError('NOT_FOUND', 'Copy source does not exist.');
    }
    const destination = await this.#resolveWriteDestination(
      workspaceId,
      destinationRelativePath,
    );
    if (destination.exists) {
      throw new LocalinkError(
        'ALREADY_EXISTS',
        'Copy destination already exists.',
      );
    }
    try {
      const sourceStat = await stat(source.absolutePath);
      if (!sourceStat.isFile()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Phase 1A-1 copy supports files only.',
        );
      }
      await copyFile(
        source.absolutePath,
        destination.absolutePath,
        constants.COPYFILE_EXCL,
      );
      return {
        source: sourceRelativePath,
        destination: destinationRelativePath,
        byteLength: sourceStat.size,
        sha256: await hashFile(destination.absolutePath),
      };
    } catch (error) {
      throw wrapIoError('Unable to copy file.', error);
    }
  }

  async move(
    workspaceId: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ): Promise<FileTransferReceipt> {
    const source = await this.#workspaces.resolve(
      workspaceId,
      sourceRelativePath,
    );
    if (!source.exists) {
      throw new LocalinkError('NOT_FOUND', 'Move source does not exist.');
    }
    const destination = await this.#resolveWriteDestination(
      workspaceId,
      destinationRelativePath,
    );
    if (destination.exists) {
      throw new LocalinkError(
        'ALREADY_EXISTS',
        'Move destination already exists.',
      );
    }
    try {
      const sourceStat = await stat(source.absolutePath);
      if (!sourceStat.isFile()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Phase 1A-1 move supports files only.',
        );
      }
      const digest = await hashFile(source.absolutePath);
      await renamePath(source.absolutePath, destination.absolutePath);
      return {
        source: sourceRelativePath,
        destination: destinationRelativePath,
        byteLength: sourceStat.size,
        sha256: digest,
      };
    } catch (error) {
      if (nodeErrorCode(error) === 'EXDEV') {
        throw new LocalinkError(
          'IO_ERROR',
          'Cross-device move is not supported by the normal move operation.',
        );
      }
      throw wrapIoError('Unable to move file.', error);
    }
  }

  async rename(
    workspaceId: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
  ): Promise<FileTransferReceipt> {
    return this.move(workspaceId, sourceRelativePath, destinationRelativePath);
  }

  async searchPaths(
    workspaceId: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchReceipt> {
    if (query.length === 0) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Path search query is required.',
      );
    }
    const maxMatches = assertPositiveBound(
      options.maxMatches ?? FILE_LIMITS.defaultSearchMatches,
      FILE_LIMITS.hardSearchMatches,
      'search maxMatches',
    );
    return this.#walk(
      workspaceId,
      options.relativePath ?? '',
      maxMatches,
      async (entry) =>
        entry.relativePath.includes(query)
          ? { relativePath: entry.relativePath }
          : undefined,
    );
  }

  async searchContent(
    workspaceId: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchReceipt> {
    if (query.length === 0) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Content search query is required.',
      );
    }
    const maxMatches = assertPositiveBound(
      options.maxMatches ?? FILE_LIMITS.defaultSearchMatches,
      FILE_LIMITS.hardSearchMatches,
      'search maxMatches',
    );
    return this.#walk(
      workspaceId,
      options.relativePath ?? '',
      maxMatches,
      async (entry, counters) => {
        if (entry.kind !== 'file') return undefined;
        if (entry.size > FILE_LIMITS.hardTextBytes) {
          counters.skippedOversize += 1;
          return undefined;
        }
        try {
          const receipt = await this.readText(
            workspaceId,
            entry.relativePath,
            FILE_LIMITS.hardTextBytes,
          );
          const lines = receipt.text.split(/\r?\n/u);
          const index = lines.findIndex((line) => line.includes(query));
          return index === -1
            ? undefined
            : {
                relativePath: entry.relativePath,
                line: index + 1,
                preview: lines[index]?.slice(0, 240) ?? '',
              };
        } catch (error) {
          if (
            error instanceof LocalinkError &&
            error.code === 'BINARY_NOT_SUPPORTED'
          ) {
            counters.skippedBinary += 1;
            return undefined;
          }
          throw error;
        }
      },
    );
  }

  async archive(
    workspaceId: string,
    relativePath: string,
  ): Promise<ArchiveReceipt> {
    const source = await this.#workspaces.resolve(workspaceId, relativePath);
    if (!source.exists) {
      throw new LocalinkError('NOT_FOUND', 'Archive source does not exist.');
    }
    try {
      const sourceStat = await stat(source.absolutePath);
      if (!sourceStat.isFile()) {
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Phase 1A-1 archive supports files only.',
        );
      }
      const digest = await hashFile(source.absolutePath);
      const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
      const archivePath = path.join(
        this.#statePaths.archive,
        workspaceId,
        `${timestamp}-${randomUUID()}`,
        relativePath,
      );
      await mkdir(path.dirname(archivePath), { recursive: true });
      let crossDeviceFallback = false;
      try {
        await renamePath(source.absolutePath, archivePath);
      } catch (error) {
        if (nodeErrorCode(error) !== 'EXDEV') throw error;
        crossDeviceFallback = true;
        try {
          await copyFile(
            source.absolutePath,
            archivePath,
            constants.COPYFILE_EXCL,
          );
          const copiedDigest = await hashFile(archivePath);
          if (copiedDigest !== digest) {
            throw new LocalinkError(
              'IO_ERROR',
              'Archive copy verification failed; source was preserved.',
            );
          }
          await unlink(source.absolutePath);
        } catch (fallbackError) {
          await unlink(archivePath).catch(() => undefined);
          throw fallbackError;
        }
      }
      return {
        workspaceId,
        originalRelativePath: relativePath,
        archivePath,
        byteLength: sourceStat.size,
        sha256: digest,
        movedAt: new Date().toISOString(),
        crossDeviceFallback,
      };
    } catch (error) {
      throw wrapIoError('Unable to archive file.', error);
    }
  }

  async batch<T, R>(
    items: readonly T[],
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length > FILE_LIMITS.hardBatchItems) {
      throw new LocalinkError(
        'SIZE_LIMIT_EXCEEDED',
        'Batch exceeds the hard item limit.',
        { itemCount: items.length, hardMax: FILE_LIMITS.hardBatchItems },
      );
    }
    const results: R[] = [];
    for (const [index, item] of items.entries()) {
      results.push(await worker(item, index));
    }
    return results;
  }

  #assertWriteSize(content: Buffer): void {
    if (content.byteLength > FILE_LIMITS.hardTextBytes) {
      throw new LocalinkError(
        'SIZE_LIMIT_EXCEEDED',
        'Text write exceeds the hard size limit.',
        {
          byteLength: content.byteLength,
          hardMax: FILE_LIMITS.hardTextBytes,
        },
      );
    }
  }

  async #resolveWriteDestination(workspaceId: string, relativePath: string) {
    const destination = await this.#workspaces.resolve(
      workspaceId,
      relativePath,
    );
    const parentRelative = path.dirname(relativePath);
    const parent = await this.#workspaces.resolve(
      workspaceId,
      parentRelative === '.' ? '' : parentRelative,
    );
    if (!parent.exists || !(await stat(parent.absolutePath)).isDirectory()) {
      throw new LocalinkError(
        'NOT_FOUND',
        'Destination parent directory does not exist.',
        { relativePath },
      );
    }
    return destination;
  }

  #writeReceipt(relativePath: string, content: Buffer): FileWriteReceipt {
    return {
      relativePath,
      byteLength: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  async #walk(
    workspaceId: string,
    rootRelativePath: string,
    maxMatches: number,
    matcher: (
      entry: FileEntry,
      counters: { skippedBinary: number; skippedOversize: number },
    ) => Promise<SearchMatch | undefined>,
  ): Promise<SearchReceipt> {
    const queue = [rootRelativePath];
    const matches: SearchMatch[] = [];
    const counters = { skippedBinary: 0, skippedOversize: 0 };
    let scannedEntries = 0;
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const directory = await this.#workspaces.resolve(workspaceId, current);
      if (!directory.exists) {
        throw new LocalinkError('NOT_FOUND', 'Search root does not exist.', {
          rootRelativePath,
        });
      }
      const entries = await readdir(directory.absolutePath, {
        withFileTypes: true,
      });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const directoryEntry of entries) {
        scannedEntries += 1;
        if (scannedEntries > FILE_LIMITS.hardSearchEntries) {
          truncated = true;
          queue.length = 0;
          break;
        }
        const entryRelative = relativeJoin(current, directoryEntry.name);
        const resolved = await this.#workspaces.resolve(
          workspaceId,
          entryRelative,
        );
        const entryStat = await stat(resolved.absolutePath);
        const entry: FileEntry = {
          relativePath: entryRelative,
          name: directoryEntry.name,
          kind: kindOf(directoryEntry),
          size: entryStat.size,
          modifiedAt: entryStat.mtime.toISOString(),
        };
        const match = await matcher(entry, counters);
        if (match !== undefined) matches.push(match);
        if (matches.length >= maxMatches) {
          truncated = true;
          queue.length = 0;
          break;
        }
        if (directoryEntry.isDirectory()) queue.push(entryRelative);
      }
    }
    return { matches, truncated, scannedEntries, ...counters };
  }
}
