import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_STDIN_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 2_000;
const PROCESS_GROUP_VERIFY_ATTEMPTS = 20;
const PROCESS_GROUP_VERIFY_INTERVAL_MS = 50;

export interface ManagedAppServerClientOptions {
  executable: string;
  launchArgs?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (id: string | number, method: string, params: unknown) => void;
  onCrash?: (reason: string) => void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type ClientState = 'idle' | 'starting' | 'ready' | 'closing';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(value: unknown): string {
  if (isRecord(value) && typeof value.message === 'string') {
    return value.message.slice(0, 500);
  }
  return 'unknown App Server error';
}

function objectError(value: unknown): { code: number } {
  return isRecord(value) && typeof value.code === 'number'
    ? { code: value.code }
    : { code: -32603 };
}

export class AppServerRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'AppServerRpcError';
    this.code = code;
  }
}

export class ManagedAppServerClient {
  readonly #options: ManagedAppServerClientOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #state: ClientState = 'idle';
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #stdoutBuffer = '';
  #stderrTail = '';
  #crashReported = false;
  #forceKillTimer: NodeJS.Timeout | null = null;

  constructor(options: ManagedAppServerClientOptions) {
    if (!options.executable || !options.executable.startsWith('/')) {
      throw new Error('Codex executable must be an absolute path');
    }
    this.#options = options;
  }

  start(): Promise<void> {
    if (this.#state === 'ready') return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    if (this.#state === 'closing' || this.#closePromise) {
      return Promise.reject(new Error('App Server client is closing'));
    }
    this.#startPromise = this.#startInternal().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async #startInternal(): Promise<void> {
    this.#state = 'starting';
    this.#stdoutBuffer = '';
    this.#stderrTail = '';
    this.#crashReported = false;
    const child = spawn(
      this.#options.executable,
      [...(this.#options.launchArgs ?? []), 'app-server', '--stdio'],
      {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        ...(this.#options.environment
          ? { env: this.#options.environment }
          : {}),
      },
    );
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#receive(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.stdin.on('error', () => {
      // The process may exit between an RPC write and the stream flush.
    });
    child.on('error', (error: Error) => {
      this.#protocolFailure(`spawn error: ${error.message}`);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#processEnded(
        child,
        `exit code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      );
    });

    try {
      await this.#sendRequest(
        'initialize',
        {
          clientInfo: {
            name: 'localink-codex-agent',
            title: 'Localink Codex Agent',
            version: '0.1.0',
          },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (this.#child !== child || this.#state !== 'starting') {
        throw new Error('App Server exited during initialize');
      }
      this.#write({ jsonrpc: '2.0', method: 'initialized' });
      this.#state = 'ready';
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.#state !== 'ready') {
      return Promise.reject(new Error('App Server client is not ready'));
    }
    return this.#sendRequest(method, params, timeoutMs);
  }

  #sendRequest(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (!method || this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('App Server request limit reached'));
    }
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      return Promise.reject(new Error('Invalid App Server request timeout'));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`App Server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: string | number, result: unknown): void {
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new Error('Invalid App Server request id');
    }
    this.#write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      !Number.isInteger(code)
    ) {
      throw new Error('Invalid App Server error response');
    }
    this.#write({
      jsonrpc: '2.0',
      id,
      error: { code, message: message.slice(0, 500) },
    });
  }

  processId(): number | undefined {
    return this.#child?.pid;
  }

  #signalOwnedTree(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ESRCH'
      ) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EPERM'
        ) {
          child.kill(signal);
          return;
        }
        throw error;
      }
    }
  }

  #ownedTreeAlive(pid: number): boolean {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 0);
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        return true;
      }
      return !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ESRCH'
      );
    }
  }

  #write(message: Record<string, unknown>): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error('App Server stdin is unavailable');
    }
    const encoded = JSON.stringify(message) + '\n';
    const bytes = Buffer.byteLength(encoded);
    if (
      bytes > MAX_LINE_BYTES ||
      child.stdin.writableLength + bytes > MAX_STDIN_BUFFER_BYTES
    ) {
      throw new Error('App Server stdin buffer limit reached');
    }
    child.stdin.write(encoded);
  }

  #receive(chunk: string): void {
    if (this.#isClosing()) return;
    this.#stdoutBuffer += chunk;
    if (
      Buffer.byteLength(this.#stdoutBuffer) > MAX_LINE_BYTES &&
      !this.#stdoutBuffer.includes('\n')
    ) {
      this.#protocolFailure('App Server stdout line limit exceeded');
      return;
    }
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.#protocolFailure('App Server stdout line limit exceeded');
        return;
      }
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#protocolFailure('App Server stdout contained invalid JSON');
        return;
      }
      this.#dispatch(message);
      if (this.#isClosing()) return;
    }
    if (Buffer.byteLength(this.#stdoutBuffer) > MAX_LINE_BYTES) {
      this.#protocolFailure('App Server stdout line limit exceeded');
    }
  }

  #isClosing(): boolean {
    return this.#state === 'closing';
  }

  #dispatch(message: unknown): void {
    if (!isRecord(message)) {
      this.#protocolFailure('App Server emitted an invalid JSON-RPC message');
      return;
    }
    const id = message.id;
    if (typeof message.method === 'string') {
      if (typeof id === 'string' || typeof id === 'number') {
        try {
          if (this.#options.onRequest) {
            this.#options.onRequest(id, message.method, message.params);
          } else {
            this.#write({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32601,
                message: 'Unsupported App Server request',
              },
            });
          }
        } catch {
          try {
            this.#write({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message: 'App Server request handler failed',
              },
            });
          } catch {
            this.#protocolFailure('App Server request handler response failed');
          }
        }
      } else {
        try {
          this.#options.onNotification?.(message.method, message.params);
        } catch {
          // A consumer callback must not corrupt the JSON-RPC transport.
        }
      }
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const rpcError = objectError(message.error);
      pending.reject(
        new AppServerRpcError(
          rpcError.code,
          `App Server RPC ${id}: ${errorText(message.error)}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #protocolFailure(reason: string): void {
    const child = this.#child;
    if (!child || this.#state === 'closing') return;
    this.#state = 'closing';
    this.#rejectPending(reason);
    this.#reportCrash(reason);
    this.#signalOwnedTree(child, 'SIGTERM');
    this.#forceKillTimer = setTimeout(() => {
      if (this.#child === child) this.#signalOwnedTree(child, 'SIGKILL');
    }, CLOSE_TIMEOUT_MS);
  }

  #processEnded(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.#child !== child) return;
    const expected = this.#state === 'closing';
    if (this.#forceKillTimer) {
      clearTimeout(this.#forceKillTimer);
      this.#forceKillTimer = null;
    }
    this.#child = null;
    this.#state = this.#closePromise ? 'closing' : 'idle';
    this.#stdoutBuffer = '';
    this.#rejectPending(reason);
    if (!expected) this.#reportCrash(reason);
  }

  #rejectPending(reason: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`App Server unavailable: ${reason}`));
    }
    this.#pending.clear();
  }

  #reportCrash(reason: string): void {
    if (this.#crashReported) return;
    this.#crashReported = true;
    try {
      this.#options.onCrash?.(reason);
    } catch {
      // Crash reporting must not interrupt transport cleanup.
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#closeInternal().finally(() => {
      this.#closePromise = null;
    });
    return this.#closePromise;
  }

  async #closeInternal(): Promise<void> {
    const child = this.#child;
    this.#state = 'closing';
    if (!child) {
      this.#state = 'idle';
      return;
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('App Server client closed'));
    }
    this.#pending.clear();
    const stopped = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('close', () => resolve());
    });
    const pid = child.pid;
    if (!child.stdin.destroyed) child.stdin.end();
    this.#signalOwnedTree(child, 'SIGTERM');
    const timer = setTimeout(
      () => this.#signalOwnedTree(child, 'SIGKILL'),
      CLOSE_TIMEOUT_MS,
    );
    try {
      await stopped;
    } finally {
      clearTimeout(timer);
      if (this.#child === child) this.#child = null;
      this.#state = 'idle';
    }
    if (pid !== undefined && process.platform !== 'win32') {
      for (
        let attempt = 0;
        attempt < PROCESS_GROUP_VERIFY_ATTEMPTS;
        attempt++
      ) {
        if (!this.#ownedTreeAlive(pid)) return;
        await new Promise((resolve) =>
          setTimeout(resolve, PROCESS_GROUP_VERIFY_INTERVAL_MS),
        );
      }
      throw new Error('App Server owned process tree did not exit');
    }
  }
}
