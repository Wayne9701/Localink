import type {
  FilesService,
  PreciseEditInput,
  ProcessManager,
  WorkspaceRegistry,
} from '@localink/core';
import { LocalinkError, type ExecInput, type StartInput } from '@localink/sdk';
import type { ProcessPolicy } from './process-policy.js';

export interface PublicWorkspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly ready: true;
  readonly rootAvailable: true;
}

export interface PublicProcessInput {
  readonly workspaceId: string;
  readonly command: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface PublicProcessStartInput extends PublicProcessInput {
  readonly killOnTimeout?: boolean;
}

export interface PublicProcessReceipt {
  readonly processId: string;
  readonly state: 'running' | 'exited' | 'stopped' | 'failed';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly timedOut: boolean;
  readonly stdout: { text: string; byteLength: number; truncated: boolean };
  readonly stderr: { text: string; byteLength: number; truncated: boolean };
}

const SAFE_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'] as const;

function publicWorkspace(record: {
  id: string;
  name: string;
  createdAt: string;
}): PublicWorkspace {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    ready: true,
    rootAvailable: true,
  };
}

function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = environment[key];
    if (value !== undefined) selected[key] = value;
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key.startsWith('LC_') && value !== undefined) selected[key] = value;
  }
  return selected;
}

function publicProcess(
  receipt: Awaited<ReturnType<ProcessManager['exec']>>,
): PublicProcessReceipt {
  return {
    processId: receipt.processId,
    state: receipt.state,
    startedAt: receipt.startedAt,
    ...(receipt.endedAt === undefined ? {} : { endedAt: receipt.endedAt }),
    ...(receipt.exitCode === undefined ? {} : { exitCode: receipt.exitCode }),
    ...(receipt.signal === undefined ? {} : { signal: receipt.signal }),
    timedOut: receipt.timedOut,
    stdout: receipt.stdout,
    stderr: receipt.stderr,
  };
}

export class NativeToolFacade {
  readonly #getProcessPolicy: () => ProcessPolicy;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    readonly workspaces: WorkspaceRegistry,
    readonly files: FilesService,
    readonly processes: ProcessManager,
    getProcessPolicy: () => ProcessPolicy,
    environment: NodeJS.ProcessEnv,
  ) {
    this.#getProcessPolicy = getProcessPolicy;
    this.#environment = environment;
  }

  workspaceList(): PublicWorkspace[] {
    return this.workspaces.list().map(publicWorkspace);
  }

  workspaceInspect(workspaceId: string): PublicWorkspace {
    return publicWorkspace(this.workspaces.inspect(workspaceId));
  }

  processPolicy(): ProcessPolicy {
    return this.#getProcessPolicy();
  }

  async processExec(input: PublicProcessInput): Promise<PublicProcessReceipt> {
    return publicProcess(await this.processes.exec(this.#processInput(input)));
  }

  async processStart(
    input: PublicProcessStartInput,
  ): Promise<PublicProcessReceipt> {
    const internal: StartInput = {
      ...this.#processInput(input),
      ...(input.killOnTimeout === undefined
        ? {}
        : { killOnTimeout: input.killOnTimeout }),
    };
    return publicProcess(await this.processes.start(internal));
  }

  processPoll(processId: string): PublicProcessReceipt {
    this.#assertProcessEnabled();
    return publicProcess(this.processes.poll(processId));
  }

  async processInput(
    processId: string,
    data: string,
  ): Promise<PublicProcessReceipt> {
    this.#assertProcessEnabled();
    return publicProcess(await this.processes.input(processId, data));
  }

  async processStop(
    processId: string,
    graceMs?: number,
    forceKill?: boolean,
  ): Promise<PublicProcessReceipt> {
    this.#assertProcessEnabled();
    return publicProcess(
      await this.processes.stop({
        processId,
        ...(graceMs === undefined ? {} : { graceMs }),
        ...(forceKill === undefined ? {} : { forceKill }),
      }),
    );
  }

  preciseEdit(input: PreciseEditInput) {
    return this.files.preciseEdit(input);
  }

  #processInput(input: PublicProcessInput): ExecInput {
    this.#assertProcessEnabled();
    return {
      workspaceId: input.workspaceId,
      command: input.command,
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: input.maxOutputBytes }),
      env: sanitizedEnvironment(this.#environment),
      inheritEnv: false,
    };
  }

  #assertProcessEnabled(): void {
    if (!this.#getProcessPolicy().enabled) {
      throw new LocalinkError(
        'POLICY_DENIED',
        'Public process execution is disabled by local admin policy.',
      );
    }
  }
}
