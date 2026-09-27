import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AgentError, type AgentTask } from './types.js';

interface InventoryDocument {
  readonly version: 1;
  readonly tasks: readonly AgentTask[];
}

function isTask(value: unknown): value is AgentTask {
  if (typeof value !== 'object' || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.agentRef === 'string' &&
    typeof task.taskTitle === 'string' &&
    typeof task.workspaceId === 'string' &&
    typeof task.canonicalRepoRoot === 'string' &&
    typeof task.status === 'string' &&
    typeof task.terminal === 'boolean' &&
    typeof task.writerReleased === 'boolean' &&
    typeof task.archived === 'boolean' &&
    typeof task.startedAt === 'string' &&
    typeof task.updatedAt === 'string' &&
    typeof task.nextSeq === 'number'
  );
}

export class AgentInventory {
  readonly path: string;

  constructor(stateRoot: string) {
    this.path = path.join(stateRoot, 'state', 'codex-agent-inventory.json');
  }

  async read(): Promise<AgentTask[]> {
    let raw: string;
    try {
      const file = await lstat(this.path);
      if (!file.isFile() || (file.mode & 0o077) !== 0) {
        throw new AgentError(
          'AGENT_INVENTORY_INVALID',
          'Agent inventory must be a private regular file.',
        );
      }
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return [];
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      throw new AgentError(
        'AGENT_INVENTORY_INVALID',
        'Agent inventory is invalid JSON.',
      );
    }
    if (
      typeof data !== 'object' ||
      data === null ||
      (data as Record<string, unknown>).version !== 1 ||
      !Array.isArray((data as Record<string, unknown>).tasks) ||
      !(data as InventoryDocument).tasks.every(isTask)
    ) {
      throw new AgentError(
        'AGENT_INVENTORY_INVALID',
        'Agent inventory schema is invalid.',
      );
    }
    const tasks = (data as InventoryDocument).tasks;
    if (new Set(tasks.map((task) => task.agentRef)).size !== tasks.length) {
      throw new AgentError(
        'AGENT_INVENTORY_INVALID',
        'Agent inventory has duplicate references.',
      );
    }
    return [...tasks];
  }

  async write(tasks: readonly AgentTask[]): Promise<void> {
    const directory = path.dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(
      directory,
      `.codex-agent-${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const document: InventoryDocument = { version: 1, tasks };
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      const directoryHandle = await open(directory, constants.O_RDONLY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
