import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  LocalinkError,
  type ExecInput,
  type ProcessOutput,
  type ProcessReceipt,
  type ProcessState,
  type StartInput,
  type StopInput,
} from '@localink/sdk';
import type { WorkspaceRegistry } from '../workspace/workspace-registry.js';

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const HARD_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_STOP_GRACE_MS = 1000;

class BoundedOutput {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #capturedBytes = 0;
  #observedBytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer): void {
    this.#observedBytes += chunk.byteLength;
    const remaining = this.#limit - this.#capturedBytes;
    if (remaining <= 0) return;
    const selected = chunk.subarray(0, remaining);
    this.#chunks.push(selected);
    this.#capturedBytes += selected.byteLength;
  }

  receipt(): ProcessOutput {
    return {
      text: Buffer.concat(this.#chunks).toString('utf8'),
      byteLength: this.#observedBytes,
      truncated: this.#observedBytes > this.#capturedBytes,
    };
  }
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  processId: string;
  startedAt: string;
  endedAt?: string;
  cwd: string;
  state: ProcessState;
  exitCode?: number;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  stopRequested: boolean;
  stdout: BoundedOutput;
  stderr: BoundedOutput;
  terminal: Promise<void>;
  resolveTerminal: () => void;
}

function assertInput(input: ExecInput): void {
  if (input.command.length === 0 || input.command.includes('\0')) {
    throw new LocalinkError('INVALID_ARGUMENT', 'Process command is invalid.');
  }
  for (const argument of input.args ?? []) {
    if (argument.includes('\0')) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Process arguments must not contain NUL bytes.',
      );
    }
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)
  ) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      'timeoutMs must be a positive integer.',
    );
  }
}

function outputLimit(input: ExecInput): number {
  const value = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(value) || value <= 0 || value > HARD_MAX_OUTPUT_BYTES) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      `maxOutputBytes must be between 1 and ${HARD_MAX_OUTPUT_BYTES}.`,
    );
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ProcessManager {
  readonly #workspaces: WorkspaceRegistry;
  readonly #processes = new Map<string, ManagedProcess>();

  constructor(workspaces: WorkspaceRegistry) {
    this.#workspaces = workspaces;
  }

  async exec(input: ExecInput): Promise<ProcessReceipt> {
    const managed = await this.#spawn(input);
    let timeoutHandle: NodeJS.Timeout | undefined;
    let forceHandle: NodeJS.Timeout | undefined;
    if (input.timeoutMs !== undefined && managed.state === 'running') {
      timeoutHandle = setTimeout(() => {
        managed.timedOut = true;
        managed.stopRequested = true;
        managed.child.kill('SIGTERM');
        forceHandle = setTimeout(() => {
          if (managed.state === 'running') managed.child.kill('SIGKILL');
        }, DEFAULT_STOP_GRACE_MS);
        forceHandle.unref();
      }, input.timeoutMs);
      timeoutHandle.unref();
    }
    await managed.terminal;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (forceHandle !== undefined) clearTimeout(forceHandle);
    this.#processes.delete(managed.processId);
    return this.#receipt(managed);
  }

  async start(input: StartInput): Promise<ProcessReceipt> {
    const managed = await this.#spawn(input);
    if (input.timeoutMs !== undefined && managed.state === 'running') {
      const timeoutHandle = setTimeout(() => {
        managed.timedOut = true;
        void this.stop({
          processId: managed.processId,
          graceMs: DEFAULT_STOP_GRACE_MS,
          forceKill: input.killOnTimeout ?? true,
        });
      }, input.timeoutMs);
      timeoutHandle.unref();
      void managed.terminal.then(() => clearTimeout(timeoutHandle));
    }
    return this.#receipt(managed);
  }

  poll(processId: string): ProcessReceipt {
    return this.#receipt(this.#get(processId));
  }

  async input(processId: string, data: string): Promise<ProcessReceipt> {
    const managed = this.#get(processId);
    if (managed.state !== 'running' || !managed.child.stdin.writable) {
      throw new LocalinkError(
        'PROCESS_NOT_RUNNING',
        'Process is not accepting input.',
        { processId, state: managed.state },
      );
    }
    await new Promise<void>((resolve, reject) => {
      managed.child.stdin.write(data, (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
    return this.#receipt(managed);
  }

  async stop(input: StopInput): Promise<ProcessReceipt> {
    const managed = this.#get(input.processId);
    if (managed.state !== 'running') return this.#receipt(managed);
    const graceMs = input.graceMs ?? DEFAULT_STOP_GRACE_MS;
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 30_000) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'graceMs must be an integer between 0 and 30000.',
      );
    }
    managed.stopRequested = true;
    managed.child.kill('SIGTERM');
    await Promise.race([managed.terminal, delay(graceMs)]);
    if (managed.state === 'running' && input.forceKill === true) {
      managed.child.kill('SIGKILL');
      await Promise.race([managed.terminal, delay(graceMs)]);
    }
    return this.#receipt(managed);
  }

  async #spawn(input: ExecInput): Promise<ManagedProcess> {
    assertInput(input);
    const limit = outputLimit(input);
    const cwd = await this.#workspaces.resolveCwd(
      input.workspaceId,
      input.cwd ?? '',
    );
    const child = spawn(input.command, input.args ?? [], {
      cwd,
      env: { ...process.env, ...input.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let resolveTerminal = (): void => undefined;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const managed: ManagedProcess = {
      child,
      processId: randomUUID(),
      startedAt: new Date().toISOString(),
      cwd,
      state: 'running',
      timedOut: false,
      stopRequested: false,
      stdout: new BoundedOutput(limit),
      stderr: new BoundedOutput(limit),
      terminal,
      resolveTerminal,
    };
    this.#processes.set(managed.processId, managed);

    child.stdout.on('data', (chunk: Buffer) => managed.stdout.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => managed.stderr.append(chunk));
    child.once('error', (error) => {
      managed.stderr.append(Buffer.from(error.message, 'utf8'));
      this.#finalize(managed, 'failed');
    });
    child.once('close', (exitCode, signal) => {
      if (exitCode !== null) managed.exitCode = exitCode;
      if (signal !== null) managed.signal = signal;
      this.#finalize(
        managed,
        managed.stopRequested || managed.timedOut ? 'stopped' : 'exited',
      );
    });

    await new Promise<void>((resolve) => {
      if (managed.state !== 'running') {
        resolve();
        return;
      }
      const onSpawn = (): void => {
        child.off('error', onError);
        resolve();
      };
      const onError = (): void => {
        child.off('spawn', onSpawn);
        resolve();
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    return managed;
  }

  #finalize(managed: ManagedProcess, state: ProcessState): void {
    if (managed.state !== 'running') return;
    managed.state = state;
    managed.endedAt = new Date().toISOString();
    managed.resolveTerminal();
  }

  #get(processId: string): ManagedProcess {
    const managed = this.#processes.get(processId);
    if (managed === undefined) {
      throw new LocalinkError(
        'PROCESS_NOT_FOUND',
        'Process id was not found.',
        {
          processId,
        },
      );
    }
    return managed;
  }

  #receipt(managed: ManagedProcess): ProcessReceipt {
    return {
      processId: managed.processId,
      ...(managed.child.pid === undefined
        ? {}
        : { hostPid: managed.child.pid }),
      startedAt: managed.startedAt,
      ...(managed.endedAt === undefined ? {} : { endedAt: managed.endedAt }),
      cwd: managed.cwd,
      ...(managed.exitCode === undefined ? {} : { exitCode: managed.exitCode }),
      ...(managed.signal === undefined ? {} : { signal: managed.signal }),
      timedOut: managed.timedOut,
      stdout: managed.stdout.receipt(),
      stderr: managed.stderr.receipt(),
      state: managed.state,
    };
  }
}
