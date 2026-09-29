import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AgentInventory } from './agent-inventory.js';
import { boundedSchema, validateMcpFormContent } from './mcp-elicitation.js';
import {
  AppServerRpcError,
  ManagedAppServerClient,
} from './app-server-client.js';
import {
  CAPABILITY_PROFILE,
  LEGACY_CAPABILITY_PROFILE,
  projectCodexNativeCapabilities,
} from './capability-profile.js';
import {
  AgentError,
  type AgentApprovalInput,
  type AgentController,
  type AgentInteractionInput,
  type AgentListInput,
  type AgentManagerOptions,
  type AgentRefInput,
  type AgentSendInput,
  type AgentStartInput,
  type AgentStatus,
  type AgentTask,
  type AgentWaitInput,
  type AppServerCallbacks,
  type AppServerPort,
  type ResolvedAgentWorkspace,
} from './types.js';

const execFileAsync = promisify(execFile);
const MAX_TITLE = 160;
const MAX_PROMPT = 16 * 1024;
const MAX_RESULT = 4096;
const MAX_WAIT_MS = 15_000;
const DEFAULT_WAIT_MS = 8_000;
const METADATA_TIMEOUT_MS = 5_000;
const MAX_RECONCILE_PAGES = 10;
const THREAD_NAME_PREFIX = '[Localink] ';
const AGENT_EXECUTION_CONTRACT = [
  '<localink_execution_contract>',
  'Keep verbose test stdout/stderr in a temporary or workspace file.',
  'Return only PASS/FAIL, exit code, and a bounded tail or summary in commentary and final output.',
  'Do not dump complete long test logs, large diffs, or large JSON/API responses; use a diff stat plus targeted excerpts and return the saved path when full output must be retained.',
  'Do not build, install, activate, or roll back a Localink release; do not bootstrap or restart Localink services; and do not mutate launchctl entries for com.localink.*. Deployment belongs to an external supervisor after this Agent is terminal.',
  'Commit or push only when the user task explicitly authorizes it.',
  '</localink_execution_contract>',
].join('\n');
const ACTIVE = new Set<AgentStatus>([
  'starting',
  'running',
  'awaiting_approval',
  'awaiting_interaction',
  'unknown',
]);

interface ModelCatalogEntry {
  readonly id: string;
  readonly isDefault?: boolean;
  readonly hidden?: boolean;
  readonly supportedReasoningEfforts?: readonly {
    readonly reasoningEffort: string;
  }[];
  readonly defaultReasoningEffort?: string;
}

interface ApprovalHandle {
  readonly requestId: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly threadId: string;
  readonly turnId: string;
}

interface InteractionHandle {
  readonly requestId: string | number;
  readonly params: Record<string, unknown>;
  readonly threadId: string;
  readonly turnId?: string | undefined;
  readonly serverName: string;
  readonly mode: string;
  readonly requestedSchema?: Record<string, unknown> | undefined;
}

interface OfficialThreadMetadata {
  readonly thread: Record<string, unknown>;
  readonly archived: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bounded(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= maxBytes
    ? value
    : `${bytes.subarray(0, maxBytes).toString('utf8')}…`;
}

function executionPrompt(value: string): string {
  return `${value.trimEnd()}\n\n${AGENT_EXECUTION_CONTRACT}`;
}

function now(): string {
  return new Date().toISOString();
}

function isTerminal(status: AgentStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function turnStatus(value: unknown): string | undefined {
  return string(object(value).status);
}

function finalMessage(value: unknown): string | undefined {
  const items = object(value).items;
  if (!Array.isArray(items)) return undefined;
  const messages = items
    .map((item) => object(item))
    .filter((item) => item.type === 'agentMessage')
    .map((item) => string(item.text) ?? string(item.message))
    .filter((item): item is string => item !== undefined);
  return messages.length > 0
    ? bounded(messages[messages.length - 1] ?? '', MAX_RESULT)
    : undefined;
}

function diagnostics(task: AgentTask, next: string): readonly string[] {
  return [...(task.lifecycleDiagnostics ?? []), next].slice(-10);
}

function threadDisplayName(taskTitle: string): string {
  return `${THREAD_NAME_PREFIX}${taskTitle}`;
}

function action(task: AgentTask): string {
  if (task.taskAppServerState === 'release_pending') return 'release_pending';
  if (task.workspaceAuthorizationStatus === 'revoked') return 'cleanup_only';
  if (task.pendingApproval?.actionable) return 'handle_approval';
  if (task.pendingInteraction) return 'handoff_to_user';
  if (task.terminal)
    return task.lifecycleIntegrity === 'recovery_failed' && !task.archived
      ? 'archive'
      : 'verify_terminal';
  if (task.status === 'unknown') return 'diagnose_uncertain';
  if (task.supervisionMode === 'detached') return 'handoff_to_user';
  return 'wait_bounded';
}

function publicTask(task: AgentTask, includeThreadId = false) {
  return {
    agentRef: task.agentRef,
    title: task.taskTitle,
    workspaceId: task.workspaceId,
    workspace: task.workspaceName,
    repo: task.repo,
    status: task.status,
    taskStatus: task.taskStatus,
    ...(task.turnStatus ? { turnStatus: task.turnStatus } : {}),
    attention: task.pendingApproval
      ? 'manual_approval'
      : task.pendingInteraction
        ? task.pendingInteraction.kind
        : 'none',
    supervisionMode: task.supervisionMode,
    recommendedAction: action(task),
    terminal: task.terminal,
    writerReleased: task.writerReleased,
    writerReleasedDeprecated: true,
    repoWriterReleased: task.repoWriterReleased,
    taskAppServerState: task.taskAppServerState,
    officialSessionReleased: task.officialSessionReleased,
    officialThreadLoadState: task.officialThreadLoadState,
    archived: task.archived,
    desktopHistoryReady: task.desktopHistoryReady,
    workspaceAuthorizationStatus: task.workspaceAuthorizationStatus,
    capabilityProfile: task.capabilityProfile,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    ...(task.lastProgressAt ? { lastProgressAt: task.lastProgressAt } : {}),
    ...(task.terminalAt ? { terminalAt: task.terminalAt } : {}),
    ...(task.finalResult ? { finalResult: task.finalResult } : {}),
    ...(task.latestError ? { latestError: task.latestError } : {}),
    ...(task.lifecycleDiagnostics
      ? { lifecycleDiagnostics: task.lifecycleDiagnostics }
      : {}),
    ...(task.pendingApproval ? { pendingApproval: task.pendingApproval } : {}),
    ...(task.pendingInteraction
      ? { pendingInteraction: task.pendingInteraction }
      : {}),
    ...(task.lastAutoReview ? { lastAutoReview: task.lastAutoReview } : {}),
    ...(task.effectivePermissions
      ? { effectivePermissions: task.effectivePermissions }
      : {}),
    lifecycleIntegrity: task.lifecycleIntegrity,
    desktopMirror: task.desktopMirror,
    nextSeq: task.nextSeq,
    ...(includeThreadId && task.threadId ? { threadId: task.threadId } : {}),
  };
}

async function repoKey(cwd: string, workspaceRoot: string): Promise<string> {
  try {
    const result = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      {
        timeout: 3000,
        maxBuffer: 4096,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    );
    return await realpath(result.stdout.trim());
  } catch {
    return await realpath(workspaceRoot);
  }
}

async function canonicalWorkspace(workspace: ResolvedAgentWorkspace): Promise<
  ResolvedAgentWorkspace & {
    canonicalRoot: string;
    canonicalCwd: string;
    repo: string;
  }
> {
  const canonicalRoot = await realpath(workspace.workspaceRoot);
  const canonicalCwd = await realpath(workspace.cwd);
  const relative = path.relative(canonicalRoot, canonicalCwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AgentError(
      'WORKSPACE_AUTH_REVOKED',
      'Resolved Agent cwd is outside the authorized Workspace.',
    );
  }
  return {
    ...workspace,
    canonicalRoot,
    canonicalCwd,
    repo: await repoKey(canonicalCwd, canonicalRoot),
  };
}

function normalizePersisted(task: AgentTask): AgentTask {
  const released = task.officialSessionReleased ?? task.terminal;
  const repoReleased =
    task.repoWriterReleased ?? task.writerReleased ?? released;
  const status = task.status;
  return {
    ...task,
    canonicalWorkspaceRoot:
      task.canonicalWorkspaceRoot ?? task.canonicalRepoRoot,
    canonicalCwd: task.canonicalCwd ?? task.canonicalRepoRoot,
    workspaceAuthorizationGeneration:
      task.workspaceAuthorizationGeneration ?? 'legacy',
    taskStatus: task.taskStatus ?? status,
    repoWriterReleased: repoReleased,
    writerReleased: repoReleased,
    taskAppServerState:
      task.taskAppServerState ?? (released ? 'stopped' : 'release_pending'),
    officialSessionReleased: released,
    officialThreadLoadState:
      task.officialThreadLoadState ?? (released ? 'notLoaded' : 'unknown'),
    desktopHistoryReady:
      task.desktopHistoryReady ?? (task.terminal && released && !task.archived),
    workspaceAuthorizationStatus:
      task.workspaceAuthorizationStatus ?? 'unknown',
    capabilityProfile:
      task.capabilityProfile === CAPABILITY_PROFILE ||
      task.capabilityProfile === LEGACY_CAPABILITY_PROFILE
        ? task.capabilityProfile
        : LEGACY_CAPABILITY_PROFILE,
    pendingInteraction: task.pendingInteraction
      ? { ...task.pendingInteraction, actionable: false }
      : undefined,
  };
}

export class AgentManager implements AgentController {
  readonly #options: AgentManagerOptions;
  readonly #inventory: AgentInventory;
  readonly #tasks = new Map<string, AgentTask>();
  readonly #sessions = new Map<string, AppServerPort>();
  readonly #sessionStarts = new Map<string, Promise<AppServerPort>>();
  readonly #releaseStarts = new Map<string, Promise<AgentTask>>();
  readonly #handles = new Map<string, ApprovalHandle>();
  readonly #interactions = new Map<string, InteractionHandle>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #sectionId: string | undefined;
  #sectionPromise: Promise<string> | undefined;
  #models: readonly ModelCatalogEntry[] | undefined;
  #closed = false;
  #degradedReason: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: AgentManagerOptions) {
    this.#options = options;
    this.#inventory = new AgentInventory(options.stateRoot);
  }

  static async create(options: AgentManagerOptions): Promise<AgentManager> {
    const manager = new AgentManager(options);
    const persisted = await manager.#inventory.read();
    for (const raw of persisted) {
      const task = normalizePersisted(raw);
      manager.#tasks.set(task.agentRef, task);
    }
    if (persisted.length > 0) await manager.#recoverPersisted();
    if (options.config.enabled && !options.config.codexExecutable) {
      manager.#degradedReason = 'CODEX_EXECUTABLE_MISSING';
    }
    return manager;
  }

  status(): { state: 'disabled' | 'ready' | 'degraded'; reasonCode?: string } {
    if (!this.#options.config.enabled) return { state: 'disabled' };
    if (this.#degradedReason) {
      return { state: 'degraded', reasonCode: this.#degradedReason };
    }
    return { state: 'ready' };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    for (const callbacks of this.#waiters.values()) {
      for (const callback of callbacks) callback();
    }
    this.#waiters.clear();
    for (const [ref, client] of [...this.#sessions]) {
      const task = this.#tasks.get(ref);
      if (task && !task.terminal) {
        await this.#change(ref, {
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'MANAGER_SHUTDOWN_INTERRUPTED',
          lifecycleDiagnostics: diagnostics(task, 'manager_shutdown'),
        });
      }
      await this.#releaseSession(ref, client).catch(() => undefined);
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #require(ref: string): AgentTask {
    const task = this.#tasks.get(ref);
    if (!task)
      throw new AgentError('AGENT_NOT_FOUND', 'Unknown Agent reference.');
    return task;
  }

  async #persistAll(): Promise<void> {
    await this.#inventory.write([...this.#tasks.values()]);
  }

  async #change(
    ref: string,
    changes: Partial<AgentTask>,
    progress = false,
  ): Promise<AgentTask> {
    return this.#mutate(async () => {
      const previous = this.#require(ref);
      const status = changes.status ?? previous.status;
      const released =
        changes.officialSessionReleased ?? previous.officialSessionReleased;
      const archived = changes.archived ?? previous.archived;
      const terminal = changes.terminal ?? previous.terminal;
      const repoWriterReleased =
        changes.repoWriterReleased ??
        changes.writerReleased ??
        previous.repoWriterReleased;
      const next: AgentTask = {
        ...previous,
        ...changes,
        status,
        taskStatus: status,
        repoWriterReleased,
        writerReleased: repoWriterReleased,
        desktopHistoryReady: terminal && released && !archived,
        updatedAt: now(),
        nextSeq: previous.nextSeq + 1,
        ...(progress ? { lastProgressAt: now() } : {}),
      };
      this.#tasks.set(ref, next);
      try {
        await this.#persistAll();
      } catch (error) {
        this.#tasks.set(ref, previous);
        throw error;
      }
      for (const callback of this.#waiters.get(ref) ?? []) callback();
      return next;
    });
  }

  async #recoverPersisted(): Promise<void> {
    const releasedNonterminal: string[] = [];
    for (const task of [...this.#tasks.values()]) {
      let released = true;
      if (task.taskAppServerPid !== undefined) {
        released = await this.#terminateProcessGroup(
          task.taskAppServerPid,
        ).then(
          () => true,
          () => false,
        );
      }
      if (!task.terminal) {
        this.#tasks.set(task.agentRef, {
          ...task,
          status: 'unknown',
          taskStatus: 'unknown',
          repoWriterReleased: released,
          writerReleased: released,
          taskAppServerState: released ? 'stopped' : 'release_pending',
          ...(released ? { taskAppServerPid: undefined } : {}),
          officialSessionReleased: released,
          officialThreadLoadState: released ? 'notLoaded' : 'unknown',
          workspaceAuthorizationStatus: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: released
            ? (task.latestError ?? 'RECOVERY_SESSION_NOT_REATTACHED')
            : 'TASK_APP_SERVER_RELEASE_PENDING',
          lifecycleDiagnostics: diagnostics(
            task,
            released
              ? 'persisted_session_released_on_startup'
              : 'persisted_process_tree_exit_unconfirmed',
          ),
          updatedAt: now(),
          nextSeq: task.nextSeq + 1,
        });
        if (released) releasedNonterminal.push(task.agentRef);
      } else if (!task.officialSessionReleased || !released) {
        this.#tasks.set(task.agentRef, {
          ...task,
          repoWriterReleased: released,
          writerReleased: released,
          taskAppServerState: released ? 'stopped' : 'release_pending',
          ...(released ? { taskAppServerPid: undefined } : {}),
          officialSessionReleased: released,
          officialThreadLoadState: released ? 'notLoaded' : 'unknown',
          desktopHistoryReady: released && !task.archived,
          latestError: released
            ? task.latestError
            : 'TASK_APP_SERVER_RELEASE_PENDING',
          lifecycleDiagnostics: diagnostics(
            task,
            released
              ? 'terminal_session_recovered'
              : 'terminal_process_tree_exit_unconfirmed',
          ),
          updatedAt: now(),
          nextSeq: task.nextSeq + 1,
        });
      }
    }
    await this.#persistAll();
    await this.#finalizeReleasedRecovery(
      releasedNonterminal,
      'RECOVERY_SESSION_NOT_REATTACHED',
      'startup_recovery',
    );
  }

  async #terminateProcessGroup(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid < 2 || process.platform === 'win32') {
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (object(error).code === 'ESRCH') return;
      throw error;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (object(error).code === 'ESRCH') return;
        throw error;
      }
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (object(error).code !== 'ESRCH') throw error;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (object(error).code === 'ESRCH') return;
        throw error;
      }
    }
    throw new Error('Persisted App Server process group did not exit');
  }

  async #launchArgs(): Promise<readonly string[]> {
    if (!this.#options.config.codexExecutable) {
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'Codex executable is unavailable.',
      );
    }
    try {
      const projection = this.#options.capabilityProjector
        ? await this.#options.capabilityProjector()
        : await projectCodexNativeCapabilities(
            this.#options.config.codexExecutable,
            this.#options.environment,
          );
      return projection.launchArgs;
    } catch (error) {
      this.#degradedReason = 'CAPABILITY_ISOLATION_UNAVAILABLE';
      throw error;
    }
  }

  #callbacks(ref: string, client: () => AppServerPort | undefined) {
    return {
      onNotification: (method: string, params: unknown) => {
        void this.#notification(ref, method, params).catch(() => undefined);
      },
      onRequest: (id: string | number, method: string, params: unknown) => {
        void this.#request(ref, client(), id, method, params).catch(() => {
          try {
            client()?.respondError(
              id,
              -32603,
              'Localink could not record the interaction.',
            );
          } catch {
            // A released process has no request to answer.
          }
        });
      },
      onCrash: (reason: string) => {
        const active = client();
        if (!active) return;
        void this.#handleCrash(ref, active, reason).catch(() => undefined);
      },
    } satisfies AppServerCallbacks;
  }

  async #createSession(ref: string): Promise<AppServerPort> {
    if (this.#closed)
      throw new AgentError('AGENT_UNAVAILABLE', 'Manager is closed.');
    if (!this.#options.config.enabled)
      throw new AgentError('AGENT_DISABLED', 'Agent runtime is disabled.');
    const existing = this.#sessions.get(ref);
    if (existing) return existing;
    const starting = this.#sessionStarts.get(ref);
    if (starting) return starting;
    const start = (async () => {
      const args = await this.#launchArgs();
      const holder: { client?: AppServerPort } = {};
      const callbacks = this.#callbacks(ref, () => holder.client);
      const client =
        this.#options.clientFactory?.(callbacks, { agentRef: ref, args }) ??
        new ManagedAppServerClient({
          executable: this.#options.config.codexExecutable ?? '',
          launchArgs: args,
          ...(this.#options.environment
            ? { environment: this.#options.environment }
            : {}),
          ...callbacks,
        });
      holder.client = client;
      await client.start();
      this.#sessions.set(ref, client);
      await this.#change(ref, {
        taskAppServerState: 'running',
        taskAppServerPid: client.processId(),
        officialSessionReleased: false,
        officialThreadLoadState: 'loaded',
      });
      this.#degradedReason = undefined;
      return client;
    })();
    this.#sessionStarts.set(ref, start);
    try {
      return await start;
    } catch (error) {
      this.#degradedReason =
        error instanceof AgentError &&
        error.code === 'CAPABILITY_ISOLATION_UNAVAILABLE'
          ? 'CAPABILITY_ISOLATION_UNAVAILABLE'
          : 'APP_SERVER_START_FAILED';
      throw error;
    } finally {
      this.#sessionStarts.delete(ref);
    }
  }

  async #handleCrash(
    ref: string,
    client: AppServerPort,
    reason: string,
  ): Promise<void> {
    if (this.#sessions.get(ref) !== client) return;
    const task = this.#require(ref);
    if (task.workspaceAuthorizationStatus === 'revoked') {
      this.#clearTaskHandles(ref);
      await this.#releaseSession(ref, client);
      return;
    }
    const latestError = reason.includes('stdout line limit exceeded')
      ? 'APP_SERVER_PROTOCOL_LIMIT_EXCEEDED'
      : 'TASK_APP_SERVER_CRASH';
    await this.#change(ref, {
      status: task.terminal ? task.status : 'unknown',
      taskAppServerState: 'crashed',
      lifecycleIntegrity: 'uncertain',
      latestError,
      pendingApproval: task.pendingApproval
        ? { ...task.pendingApproval, actionable: false }
        : undefined,
      lifecycleDiagnostics: diagnostics(
        task,
        `app_server_crash:${bounded(reason, 120)}`,
      ),
    });
    this.#clearTaskHandles(ref);
    await this.#releaseSession(ref, client);
    await this.#finalizeReleasedRecovery(
      [ref],
      latestError,
      'app_server_crash_recovery',
    );
  }

  #handlesFor(ref: string): string[] {
    const task = this.#tasks.get(ref);
    if (!task?.threadId) return [];
    return [...this.#handles]
      .filter(([, handle]) => handle.threadId === task.threadId)
      .map(([id]) => id);
  }

  #interactionsFor(ref: string): string[] {
    const task = this.#tasks.get(ref);
    if (!task?.threadId) return [];
    return [...this.#interactions]
      .filter(([, handle]) => handle.threadId === task.threadId)
      .map(([id]) => id);
  }

  #clearTaskHandles(ref: string): void {
    this.#handlesFor(ref).forEach((id) => this.#handles.delete(id));
    this.#interactionsFor(ref).forEach((id) => this.#interactions.delete(id));
  }

  async #releaseSession(
    ref: string,
    expected?: AppServerPort,
  ): Promise<AgentTask> {
    const pending = this.#releaseStarts.get(ref);
    if (pending) return pending;
    const release = (async () => {
      const client = expected ?? this.#sessions.get(ref);
      if (!client) {
        return await this.#change(ref, {
          taskAppServerState: 'stopped',
          taskAppServerPid: undefined,
          officialSessionReleased: true,
          officialThreadLoadState: 'notLoaded',
          repoWriterReleased: true,
        });
      }
      await this.#change(ref, {
        taskAppServerState: 'tearing_down',
        officialSessionReleased: false,
        repoWriterReleased: false,
      });
      try {
        await client.close();
        if (this.#sessions.get(ref) === client) this.#sessions.delete(ref);
        this.#clearTaskHandles(ref);
        return await this.#change(ref, {
          taskAppServerState: 'stopped',
          taskAppServerPid: undefined,
          officialSessionReleased: true,
          officialThreadLoadState: 'notLoaded',
          repoWriterReleased: true,
          pendingApproval: undefined,
          pendingInteraction: undefined,
          lifecycleDiagnostics: diagnostics(
            this.#require(ref),
            'official_session_released',
          ),
        });
      } catch {
        return await this.#change(ref, {
          taskAppServerState: 'release_pending',
          officialSessionReleased: false,
          officialThreadLoadState: 'unknown',
          repoWriterReleased: false,
          latestError: 'TASK_APP_SERVER_RELEASE_PENDING',
          lifecycleIntegrity: 'uncertain',
          lifecycleDiagnostics: diagnostics(
            this.#require(ref),
            'owned_process_tree_exit_unconfirmed',
          ),
        });
      }
    })();
    this.#releaseStarts.set(ref, release);
    try {
      return await release;
    } finally {
      this.#releaseStarts.delete(ref);
    }
  }

  async #catalog(client: AppServerPort): Promise<readonly ModelCatalogEntry[]> {
    if (this.#models) return this.#models;
    const result = object(await client.request('model/list', {}));
    const data = result.data;
    if (!Array.isArray(data)) {
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'Official model catalog unavailable.',
      );
    }
    const models = data
      .map((entry) => object(entry))
      .filter(
        (entry): entry is Record<string, unknown> & { id: string } =>
          typeof entry.id === 'string' && entry.hidden !== true,
      ) as unknown as ModelCatalogEntry[];
    if (models.length === 0)
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'No Codex models are available.',
      );
    this.#models = models;
    return models;
  }

  async #model(
    client: AppServerPort,
    requested?: string,
    effort?: string,
    rationale?: string,
  ): Promise<{ model: string; effort: string }> {
    const models = await this.#catalog(client);
    const defaultModel = models.find((model) => model.isDefault) ?? models[0];
    const selected = models.find(
      (model) => model.id === (requested ?? defaultModel?.id),
    );
    if (!selected)
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'Requested model is unavailable.',
      );
    const supported =
      selected.supportedReasoningEfforts?.map(
        (entry) => entry.reasoningEffort,
      ) ?? [];
    const selectedEffort =
      effort ??
      (supported.includes('high')
        ? 'high'
        : (selected.defaultReasoningEffort ?? supported[0]));
    if (!selectedEffort || !supported.includes(selectedEffort)) {
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'Requested reasoning effort is unavailable.',
      );
    }
    const explicitUpgrade =
      (requested !== undefined && requested !== defaultModel?.id) ||
      (effort !== undefined && ['xhigh', 'max', 'ultra'].includes(effort));
    if (explicitUpgrade && (!rationale || rationale.trim().length === 0)) {
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'An invocation rationale is required for this model choice.',
      );
    }
    return { model: selected.id, effort: selectedEffort };
  }

  async #ensureSection(client: AppServerPort): Promise<string> {
    if (this.#sectionId) return this.#sectionId;
    if (this.#sectionPromise) return this.#sectionPromise;
    const ensure = (async () => {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = object(
          await client.request('threadSection/list', cursor ? { cursor } : {}),
        );
        const data = Array.isArray(result.data) ? result.data : [];
        const found = data
          .map(object)
          .find((section) => section.name === this.#options.config.sectionName);
        if (found) {
          const id = string(found.id);
          if (id) {
            this.#sectionId = id;
            return id;
          }
        }
        cursor = string(result.nextCursor);
        if (!cursor) break;
      }
      const id = string(
        object(
          object(
            await client.request('threadSection/create', {
              name: this.#options.config.sectionName,
            }),
          ).section,
        ).id,
      );
      if (!id) throw new Error('Section creation returned no ID.');
      this.#sectionId = id;
      return id;
    })();
    this.#sectionPromise = ensure;
    try {
      return await ensure;
    } finally {
      this.#sectionPromise = undefined;
    }
  }

  async #mirror(ref: string, client: AppServerPort): Promise<void> {
    const task = this.#require(ref);
    if (!task.threadId) return;
    const displayName = threadDisplayName(task.taskTitle);
    try {
      await client.request('thread/name/set', {
        threadId: task.threadId,
        name: displayName,
      });
      const sectionId = await this.#ensureSection(client);
      await client.request('thread/section/move', {
        threadId: task.threadId,
        sectionId,
      });
      await this.#change(ref, {
        desktopMirror: {
          status: 'confirmed',
          name: displayName,
          section: this.#options.config.sectionName,
        },
      });
    } catch {
      await this.#change(ref, {
        desktopMirror: { status: 'degraded', name: displayName },
      });
    }
  }

  async #threadStart(
    client: AppServerPort,
    cwd: string,
    model: string,
  ): Promise<{
    threadId: string;
    effective: NonNullable<AgentTask['effectivePermissions']>;
  }> {
    const base = {
      cwd,
      model,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      threadSource: 'localink-agent',
      ephemeral: false,
    };
    let result: Record<string, unknown>;
    let fallback = false;
    try {
      result = object(
        await client.request('thread/start', {
          ...base,
          permissions: ':workspace',
        }),
      );
    } catch (error) {
      if (!(error instanceof AppServerRpcError && error.code === -32602)) {
        throw error;
      }
      fallback = true;
      result = object(
        await client.request('thread/start', {
          ...base,
          sandbox: 'workspace-write',
        }),
      );
    }
    const threadId = string(object(result.thread).id);
    if (!threadId)
      throw new AgentError('AGENT_UNAVAILABLE', 'Thread start returned no ID.');
    const profile = string(object(result.activePermissionProfile).id);
    const sandbox = string(object(result.sandbox).type);
    const effectiveProfile =
      profile ??
      (fallback && sandbox === 'workspaceWrite' ? ':workspace-equivalent' : '');
    const effective = {
      activePermissionProfile: effectiveProfile,
      approvalPolicy: string(result.approvalPolicy) ?? '',
      approvalsReviewer: string(result.approvalsReviewer) ?? '',
    };
    if (
      (!fallback && effectiveProfile !== ':workspace') ||
      (fallback &&
        effectiveProfile !== ':workspace' &&
        effectiveProfile !== ':workspace-equivalent') ||
      sandbox !== 'workspaceWrite' ||
      effective.approvalPolicy !== 'on-request' ||
      effective.approvalsReviewer !== 'auto_review'
    ) {
      throw new AgentError(
        'PERMISSION_PROFILE_MISMATCH',
        'Official effective permissions do not match auto preset.',
        { threadId },
      );
    }
    return { threadId, effective };
  }

  async #resolveAuthorized(
    workspaceId: string,
    relativeCwd?: string,
  ): Promise<Awaited<ReturnType<typeof canonicalWorkspace>>> {
    try {
      return await canonicalWorkspace(
        await this.#options.resolveWorkspace(workspaceId, relativeCwd),
      );
    } catch (error) {
      if (
        error instanceof AgentError &&
        error.code === 'WORKSPACE_AUTH_REVOKED'
      ) {
        throw error;
      }
      throw new AgentError(
        'WORKSPACE_AUTH_REVOKED',
        'Workspace authorization is no longer valid.',
      );
    }
  }

  async #authorizeTask(ref: string): Promise<AgentTask> {
    const task = this.#require(ref);
    if (task.workspaceAuthorizationStatus === 'revoked') {
      throw new AgentError(
        'WORKSPACE_AUTH_REVOKED',
        'Workspace authorization is no longer valid.',
      );
    }
    try {
      const current = await this.#resolveAuthorized(
        task.workspaceId,
        task.relativeCwd || undefined,
      );
      if (
        current.canonicalRoot !== task.canonicalWorkspaceRoot ||
        current.canonicalCwd !== task.canonicalCwd ||
        current.repo !== task.canonicalRepoRoot
      ) {
        throw new AgentError(
          'WORKSPACE_AUTH_REVOKED',
          'Workspace identity changed after Agent creation.',
        );
      }
      if (
        task.workspaceAuthorizationStatus !== 'authorized' ||
        task.workspaceAuthorizationGeneration !==
          current.authorizationGeneration
      ) {
        return await this.#change(ref, {
          workspaceAuthorizationStatus: 'authorized',
          workspaceAuthorizationGeneration: current.authorizationGeneration,
        });
      }
      return task;
    } catch (error) {
      await this.#change(ref, {
        workspaceAuthorizationStatus: 'revoked',
        latestError: 'WORKSPACE_AUTH_REVOKED',
        lifecycleDiagnostics: diagnostics(
          task,
          'workspace_authorization_revoked',
        ),
      });
      throw error instanceof AgentError
        ? error
        : new AgentError(
            'WORKSPACE_AUTH_REVOKED',
            'Workspace authorization is no longer valid.',
          );
    }
  }

  async start(input: AgentStartInput): Promise<unknown> {
    if (
      !input.taskTitle?.trim() ||
      input.taskTitle.length > MAX_TITLE ||
      !input.prompt?.trim() ||
      Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT
    ) {
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'Task title or prompt is invalid.',
      );
    }
    const workspace = await this.#resolveAuthorized(
      input.workspaceId,
      input.relativeCwd,
    );
    const timestamp = now();
    const initial: AgentTask = {
      agentRef: `agent_${randomUUID().replaceAll('-', '')}`,
      taskTitle: input.taskTitle.trim(),
      workspaceId: input.workspaceId,
      workspaceName: workspace.workspaceName,
      relativeCwd: input.relativeCwd ?? '',
      canonicalWorkspaceRoot: workspace.canonicalRoot,
      canonicalCwd: workspace.canonicalCwd,
      workspaceAuthorizationGeneration: workspace.authorizationGeneration,
      canonicalRepoRoot: workspace.repo,
      repo: path.basename(workspace.repo),
      supervisionMode: input.supervisionMode ?? 'auto',
      permissionPreset: 'auto',
      status: 'starting',
      taskStatus: 'starting',
      terminal: false,
      writerReleased: false,
      repoWriterReleased: false,
      taskAppServerState: 'starting',
      officialSessionReleased: false,
      officialThreadLoadState: 'unknown',
      archived: false,
      desktopHistoryReady: false,
      workspaceAuthorizationStatus: 'authorized',
      capabilityProfile: CAPABILITY_PROFILE,
      lifecycleIntegrity: 'confirmed',
      startedAt: timestamp,
      updatedAt: timestamp,
      desktopMirror: { status: 'pending' },
      nextSeq: 0,
    };
    await this.#mutate(async () => {
      const conflict = [...this.#tasks.values()].find(
        (task) =>
          !task.archived &&
          !task.repoWriterReleased &&
          task.canonicalRepoRoot === workspace.repo,
      );
      if (conflict) {
        throw new AgentError(
          'AGENT_WRITER_CONFLICT',
          'Repository already has an active writable Agent.',
          {
            existingAgentRef: conflict.agentRef,
            title: conflict.taskTitle,
            status: conflict.status,
          },
        );
      }
      this.#tasks.set(initial.agentRef, initial);
      try {
        await this.#persistAll();
      } catch (error) {
        this.#tasks.delete(initial.agentRef);
        throw error;
      }
    });
    let turnStartAttempted = false;
    try {
      const client = await this.#createSession(initial.agentRef);
      const choice = await this.#model(
        client,
        input.model,
        input.reasoningEffort,
        input.invocationRationale,
      );
      await this.#change(initial.agentRef, {
        model: choice.model,
        reasoningEffort: choice.effort,
      });
      const started = await this.#threadStart(
        client,
        workspace.canonicalCwd,
        choice.model,
      );
      await this.#change(initial.agentRef, {
        threadId: started.threadId,
        effectivePermissions: started.effective,
      });
      await this.#mirror(initial.agentRef, client);
      turnStartAttempted = true;
      const response = object(
        await client.request('turn/start', {
          threadId: started.threadId,
          input: [
            {
              type: 'text',
              text: executionPrompt(input.prompt),
              text_elements: [],
            },
          ],
          model: choice.model,
          effort: choice.effort,
        }),
      );
      const turnId = string(object(response.turn).id);
      if (!turnId) throw new Error('Turn start returned no ID.');
      return publicTask(
        await this.#change(
          initial.agentRef,
          { turnId, turnStatus: 'inProgress', status: 'running' },
          true,
        ),
        true,
      );
    } catch (error) {
      const code =
        error instanceof AgentError ? error.code : 'AGENT_START_FAILED';
      if (turnStartAttempted) {
        await this.#change(initial.agentRef, {
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'TURN_START_UNCERTAIN',
        });
      } else {
        await this.#change(initial.agentRef, {
          status: 'failed',
          turnStatus: 'failed',
          terminal: true,
          terminalAt: now(),
          latestError: code,
        });
        await this.#releaseSession(initial.agentRef);
      }
      throw error;
    }
  }

  async #recordTerminal(
    ref: string,
    mapped: AgentStatus,
    officialTurnStatus: string,
    turn: Record<string, unknown>,
  ): Promise<AgentTask> {
    const task = this.#require(ref);
    if (!task.terminal) {
      await this.#change(
        ref,
        {
          status: mapped,
          turnStatus: officialTurnStatus,
          terminal: isTerminal(mapped),
          repoWriterReleased: false,
          officialSessionReleased: false,
          taskAppServerState: 'tearing_down',
          terminalAt: now(),
          finalResult: finalMessage(turn) ?? task.finalResult,
          latestError:
            mapped === 'failed' ? 'CODEX_TURN_FAILED' : task.latestError,
          pendingApproval: undefined,
          lifecycleIntegrity: mapped === 'unknown' ? 'uncertain' : 'confirmed',
          lifecycleDiagnostics: diagnostics(
            task,
            'official_terminal_persisted',
          ),
        },
        true,
      );
    }
    return await this.#releaseSession(ref);
  }

  #releasedRecoveryCandidate(task: AgentTask): boolean {
    return (
      !task.terminal &&
      !this.#sessions.has(task.agentRef) &&
      task.taskAppServerPid === undefined &&
      task.taskAppServerState === 'stopped' &&
      task.officialSessionReleased &&
      task.repoWriterReleased
    );
  }

  async #recordReleasedOfficialTerminal(
    ref: string,
    officialTurnStatus: 'completed' | 'failed' | 'interrupted',
    turn: Record<string, unknown>,
  ): Promise<AgentTask> {
    const task = this.#require(ref);
    const mapped: AgentStatus =
      officialTurnStatus === 'completed'
        ? 'completed'
        : officialTurnStatus === 'interrupted'
          ? 'cancelled'
          : 'failed';
    return await this.#change(
      ref,
      {
        status: mapped,
        turnStatus: officialTurnStatus,
        terminal: true,
        terminalAt: task.terminalAt ?? now(),
        finalResult: finalMessage(turn) ?? task.finalResult,
        latestError:
          mapped === 'failed' ? 'CODEX_TURN_FAILED' : task.latestError,
        pendingApproval: undefined,
        pendingInteraction: undefined,
        lifecycleIntegrity: 'confirmed',
        lifecycleDiagnostics: diagnostics(
          task,
          'official_terminal_reconciled_after_release',
        ),
      },
      true,
    );
  }

  async #finalizeReleasedRecovery(
    refs: readonly string[],
    fallbackError: string,
    diagnosticPrefix: string,
  ): Promise<void> {
    const candidates = refs
      .map((ref) => this.#tasks.get(ref))
      .filter(
        (task): task is AgentTask =>
          task !== undefined && this.#releasedRecoveryCandidate(task),
      );
    if (candidates.length === 0) return;

    const unresolved = new Set(candidates.map((task) => task.agentRef));
    let client: AppServerPort | undefined;
    try {
      if (this.#options.config.enabled) {
        client = await this.#metadataClient();
        for (const candidate of candidates) {
          if (!candidate.threadId || !candidate.turnId) continue;
          try {
            const turns = object(
              await client.request(
                'thread/turns/list',
                {
                  threadId: candidate.threadId,
                  limit: 20,
                  itemsView: 'full',
                },
                METADATA_TIMEOUT_MS,
              ),
            );
            const turn = (Array.isArray(turns.data) ? turns.data : [])
              .map(object)
              .find((entry) => entry.id === candidate.turnId);
            const status = turnStatus(turn);
            if (
              turn &&
              (status === 'completed' ||
                status === 'failed' ||
                status === 'interrupted')
            ) {
              await this.#recordReleasedOfficialTerminal(
                candidate.agentRef,
                status,
                turn,
              );
              unresolved.delete(candidate.agentRef);
            }
          } catch {
            // Fall through to the explicit local recovery failure below.
          }
        }
      }
    } catch {
      // The official read is best-effort and bounded. Once all owned resources
      // are released, Localink must still converge to a terminal state.
    } finally {
      await client?.close().catch(() => undefined);
    }

    for (const ref of unresolved) {
      const task = this.#require(ref);
      if (!this.#releasedRecoveryCandidate(task)) continue;
      const preservedError =
        task.latestError &&
        task.latestError !== 'TASK_APP_SERVER_RELEASE_PENDING'
          ? task.latestError
          : fallbackError;
      await this.#change(ref, {
        status: 'failed',
        turnStatus: 'failed',
        terminal: true,
        terminalAt: now(),
        pendingApproval: undefined,
        pendingInteraction: undefined,
        lifecycleIntegrity: 'recovery_failed',
        latestError: preservedError,
        lifecycleDiagnostics: diagnostics(
          task,
          `${diagnosticPrefix}:terminalized_released_task`,
        ),
      });
    }
  }

  async #refreshActive(ref: string, client: AppServerPort): Promise<AgentTask> {
    const task = this.#require(ref);
    if (!task.threadId || task.archived || task.terminal) return task;
    const read = object(
      await client.request('thread/read', { threadId: task.threadId }),
    );
    if (object(read.thread).id !== task.threadId) {
      throw new AgentError('AGENT_STATE_UNKNOWN', 'Official thread mismatch.');
    }
    const turns = object(
      await client.request('thread/turns/list', {
        threadId: task.threadId,
        limit: 20,
        itemsView: 'full',
      }),
    );
    const turn = (Array.isArray(turns.data) ? turns.data : [])
      .map(object)
      .find((entry) => entry.id === task.turnId);
    if (!turn) {
      return await this.#change(ref, {
        status: 'unknown',
        lifecycleIntegrity: 'uncertain',
        latestError: 'TURN_READBACK_MISSING',
      });
    }
    const status = turnStatus(turn);
    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'interrupted'
    ) {
      return await this.#recordTerminal(
        ref,
        status === 'completed'
          ? 'completed'
          : status === 'interrupted'
            ? 'cancelled'
            : 'failed',
        status,
        turn,
      );
    }
    if (status === 'inProgress') {
      return task.status === 'unknown' && !task.pendingApproval
        ? await this.#change(ref, {
            status: 'running',
            turnStatus: status,
            lifecycleIntegrity: 'confirmed',
            latestError: undefined,
          })
        : task;
    }
    return await this.#change(ref, {
      status: 'unknown',
      turnStatus: status,
      lifecycleIntegrity: 'uncertain',
      latestError: 'TURN_STATUS_UNKNOWN',
    });
  }

  async #metadataClient(): Promise<AppServerPort> {
    const args = await this.#launchArgs();
    const holder: { client?: AppServerPort } = {};
    const callbacks: AppServerCallbacks = {
      onNotification: () => undefined,
      onRequest: (id) =>
        holder.client?.respondError(
          id,
          -32601,
          'Metadata session is read-only.',
        ),
      onCrash: () => undefined,
    };
    const client =
      this.#options.clientFactory?.(callbacks, {
        agentRef: 'metadata',
        args,
      }) ??
      new ManagedAppServerClient({
        executable: this.#options.config.codexExecutable ?? '',
        launchArgs: args,
        ...(this.#options.environment
          ? { environment: this.#options.environment }
          : {}),
        ...callbacks,
      });
    holder.client = client;
    await client.start();
    return client;
  }

  async #readOfficialInventory(
    client: AppServerPort,
  ): Promise<Map<string, OfficialThreadMetadata>> {
    const result = new Map<string, OfficialThreadMetadata>();
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
        const response = object(
          await client.request(
            'thread/list',
            {
              archived,
              limit: 100,
              useStateDbOnly: true,
              sourceKinds: ['appServer', 'unknown'],
              sortKey: 'updated_at',
              sortDirection: 'desc',
              ...(cursor ? { cursor } : {}),
            },
            METADATA_TIMEOUT_MS,
          ),
        );
        for (const raw of Array.isArray(response.data) ? response.data : []) {
          const thread = object(raw);
          const id = string(thread.id);
          if (id) result.set(id, { thread, archived });
        }
        cursor = string(response.nextCursor);
        if (!cursor) break;
      }
    }
    return result;
  }

  async #reconcileMany(refs: readonly string[]): Promise<void> {
    if (refs.length === 0 || !this.#options.config.enabled) return;
    let client: AppServerPort | undefined;
    try {
      client = await this.#metadataClient();
      const official = await this.#readOfficialInventory(client);
      for (const ref of refs) {
        const task = this.#tasks.get(ref);
        if (!task?.threadId || this.#sessions.has(ref)) continue;
        const found = official.get(task.threadId);
        if (!found) {
          await this.#change(ref, {
            officialThreadLoadState: 'unknown',
            lifecycleDiagnostics: diagnostics(
              task,
              'official_metadata_not_found',
            ),
          });
          continue;
        }
        const section = object(found.thread.section);
        const officialName = string(found.thread.name);
        const officialSection = string(section.name);
        await this.#change(ref, {
          archived: found.archived,
          officialThreadLoadState:
            string(object(found.thread.status).type) === 'notLoaded'
              ? 'notLoaded'
              : 'unknown',
          desktopMirror: {
            status:
              found.thread.name === threadDisplayName(task.taskTitle) &&
              section.name === this.#options.config.sectionName
                ? 'confirmed'
                : 'degraded',
            ...(officialName ? { name: officialName } : {}),
            ...(officialSection ? { section: officialSection } : {}),
          },
        });
      }
    } catch {
      for (const ref of refs) {
        const task = this.#tasks.get(ref);
        if (!task) continue;
        await this.#change(ref, {
          lifecycleDiagnostics: diagnostics(
            task,
            'official_reconcile_unavailable',
          ),
        });
      }
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async list(input: AgentListInput = {}): Promise<unknown> {
    const recent = [...this.#tasks.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100)
      .map((task) => task.agentRef);
    await this.#reconcileMany(recent);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const tasks = [...this.#tasks.values()]
      .filter((task) => !task.archived)
      .filter(
        (task) => !input.workspaceId || task.workspaceId === input.workspaceId,
      )
      .filter((task) => !input.status || task.status === input.status)
      .sort((a, b) => {
        const priority = (task: AgentTask) =>
          ACTIVE.has(task.status) || task.pendingInteraction ? 1 : 0;
        return (
          priority(b) - priority(a) || b.updatedAt.localeCompare(a.updatedAt)
        );
      });
    return {
      items: tasks.slice(0, limit).map((task) => publicTask(task)),
      total: tasks.length,
      hasMore: tasks.length > limit,
    };
  }

  async show(input: AgentRefInput): Promise<unknown> {
    let task = this.#require(input.agentRef);
    const client = this.#sessions.get(task.agentRef);
    if (!task.terminal && client && task.taskAppServerState === 'running') {
      try {
        task = await this.#refreshActive(task.agentRef, client);
      } catch {
        task = await this.#change(task.agentRef, {
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'OFFICIAL_READBACK_UNAVAILABLE',
        });
      }
    } else {
      await this.#reconcileMany([task.agentRef]);
      task = this.#require(task.agentRef);
    }
    return publicTask(task, true);
  }

  async wait(input: AgentWaitInput): Promise<unknown> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_MS;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > MAX_WAIT_MS
    ) {
      throw new AgentError('AGENT_UNAVAILABLE', 'Wait bound is invalid.');
    }
    let task = this.#require(input.agentRef);
    if (task.terminal || task.pendingApproval || task.pendingInteraction) {
      return publicTask(task, true);
    }
    const afterSeq = input.afterSeq ?? task.nextSeq;
    if (task.nextSeq <= afterSeq && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const callbacks =
          this.#waiters.get(task.agentRef) ?? new Set<() => void>();
        const done = () => {
          clearTimeout(timer);
          callbacks.delete(done);
          resolve();
        };
        callbacks.add(done);
        this.#waiters.set(task.agentRef, callbacks);
        const timer = setTimeout(done, timeoutMs);
      });
    }
    task = this.#require(input.agentRef);
    const client = this.#sessions.get(task.agentRef);
    if (!task.terminal && client && task.taskAppServerState === 'running') {
      task = await this.#refreshActive(task.agentRef, client).catch(
        async () =>
          await this.#change(task.agentRef, {
            status: 'unknown',
            lifecycleIntegrity: 'uncertain',
            latestError: 'OFFICIAL_READBACK_UNAVAILABLE',
          }),
      );
    }
    return publicTask(task, true);
  }

  async send(input: AgentSendInput): Promise<unknown> {
    if (
      !input.message?.trim() ||
      Buffer.byteLength(input.message, 'utf8') > MAX_PROMPT
    ) {
      throw new AgentError('AGENT_UNAVAILABLE', 'Message is invalid.');
    }
    let task = this.#require(input.agentRef);
    if (task.lifecycleIntegrity === 'recovery_failed') {
      throw new AgentError(
        'AGENT_NOT_IDLE',
        'A terminal recovery failure cannot be resumed.',
      );
    }
    task = await this.#authorizeTask(input.agentRef);
    await this.#reconcileMany([task.agentRef]);
    task = this.#require(task.agentRef);
    if (
      !task.threadId ||
      task.archived ||
      task.lifecycleIntegrity === 'recovery_failed' ||
      !task.officialSessionReleased ||
      !task.repoWriterReleased ||
      (!task.terminal && task.status !== 'unknown')
    ) {
      throw new AgentError('AGENT_NOT_IDLE', 'Agent is not resumable.');
    }
    await this.#mutate(async () => {
      const conflict = [...this.#tasks.values()].find(
        (other) =>
          other.agentRef !== task.agentRef &&
          !other.archived &&
          !other.repoWriterReleased &&
          other.canonicalRepoRoot === task.canonicalRepoRoot,
      );
      if (conflict) {
        throw new AgentError(
          'AGENT_WRITER_CONFLICT',
          'Repository writer conflict.',
          {
            existingAgentRef: conflict.agentRef,
            title: conflict.taskTitle,
            status: conflict.status,
          },
        );
      }
      task = {
        ...this.#require(input.agentRef),
        status: 'starting',
        taskStatus: 'starting',
        terminal: false,
        repoWriterReleased: false,
        writerReleased: false,
        taskAppServerState: 'starting',
        officialSessionReleased: false,
        officialThreadLoadState: 'unknown',
        desktopHistoryReady: false,
        terminalAt: undefined,
        finalResult: undefined,
        latestError: undefined,
        updatedAt: now(),
      };
      this.#tasks.set(task.agentRef, task);
      await this.#persistAll();
    });
    let client: AppServerPort | undefined;
    try {
      client = await this.#createSession(task.agentRef);
      const resumed = object(
        await client.request('thread/resume', {
          threadId: task.threadId,
          permissions: ':workspace',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
          excludeTurns: true,
        }),
      );
      if (
        string(object(resumed.activePermissionProfile).id) !== ':workspace' ||
        resumed.approvalPolicy !== 'on-request' ||
        resumed.approvalsReviewer !== 'auto_review'
      ) {
        throw new AgentError(
          'PERMISSION_PROFILE_MISMATCH',
          'Resumed thread permissions differ from the auto preset.',
        );
      }
      const choice =
        input.model === undefined && input.reasoningEffort === undefined
          ? { model: task.model ?? '', effort: task.reasoningEffort ?? '' }
          : await this.#model(
              client,
              input.model ?? task.model,
              input.reasoningEffort ?? task.reasoningEffort,
              input.invocationRationale,
            );
      if (!choice.model || !choice.effort) {
        throw new AgentError(
          'AGENT_UNAVAILABLE',
          'Owned thread has no model selection.',
        );
      }
      const response = object(
        await client.request('turn/start', {
          threadId: task.threadId,
          input: [
            {
              type: 'text',
              text: executionPrompt(input.message),
              text_elements: [],
            },
          ],
          model: choice.model,
          effort: choice.effort,
        }),
      );
      const turnId = string(object(response.turn).id);
      if (!turnId) throw new Error('Turn start returned no ID.');
      return publicTask(
        await this.#change(
          task.agentRef,
          {
            turnId,
            turnStatus: 'inProgress',
            model: choice.model,
            reasoningEffort: choice.effort,
            status: 'running',
          },
          true,
        ),
        true,
      );
    } catch (error) {
      await this.#change(task.agentRef, {
        status: 'unknown',
        lifecycleIntegrity: 'uncertain',
        latestError: 'TURN_RESUME_UNCERTAIN',
      });
      if (client) {
        await this.#releaseSession(task.agentRef, client);
        await this.#finalizeReleasedRecovery(
          [task.agentRef],
          'TURN_RESUME_UNCERTAIN',
          'turn_resume_recovery',
        );
      }
      throw error;
    }
  }

  async #approval(
    input: AgentApprovalInput,
    decision: 'accept' | 'decline',
  ): Promise<unknown> {
    let task = this.#require(input.agentRef);
    if (decision === 'accept') task = await this.#authorizeTask(task.agentRef);
    if (task.terminal || task.archived || !task.pendingApproval?.actionable) {
      throw new AgentError(
        'AGENT_APPROVAL_STALE',
        'Approval is no longer actionable.',
      );
    }
    if (task.pendingApproval.approvalRequestId !== input.approvalRequestId) {
      throw new AgentError(
        'AGENT_APPROVAL_STALE',
        'Approval request ID mismatch.',
      );
    }
    const handle = this.#handles.get(input.approvalRequestId);
    const client = this.#sessions.get(task.agentRef);
    if (
      !handle ||
      !client ||
      handle.threadId !== task.threadId ||
      handle.turnId !== task.turnId
    ) {
      throw new AgentError('AGENT_APPROVAL_STALE', 'Approval handle was lost.');
    }
    this.#handles.delete(input.approvalRequestId);
    if (handle.method === 'item/permissions/requestApproval') {
      if (decision === 'accept') {
        client.respond(handle.requestId, {
          permissions: handle.params.permissions,
          scope: 'turn',
        });
      } else {
        client.respondError(
          handle.requestId,
          -32000,
          'Permission request declined.',
        );
      }
    } else {
      client.respond(handle.requestId, { decision });
    }
    return publicTask(
      await this.#change(task.agentRef, {
        pendingApproval: undefined,
        status: 'running',
      }),
      true,
    );
  }

  approve(input: AgentApprovalInput): Promise<unknown> {
    return this.#approval(input, 'accept');
  }

  reject(input: AgentApprovalInput): Promise<unknown> {
    return this.#approval(input, 'decline');
  }

  async interact(input: AgentInteractionInput): Promise<unknown> {
    let task = this.#require(input.agentRef);
    if (input.action === 'accept')
      task = await this.#authorizeTask(task.agentRef);
    if (
      task.terminal ||
      task.archived ||
      !task.pendingInteraction?.actionable
    ) {
      throw new AgentError(
        'AGENT_INTERACTION_STALE',
        'Interaction is no longer actionable.',
      );
    }
    if (
      task.pendingInteraction.interactionRequestId !==
      input.interactionRequestId
    ) {
      throw new AgentError(
        'AGENT_INTERACTION_STALE',
        'Interaction request ID mismatch.',
      );
    }
    const handle = this.#interactions.get(input.interactionRequestId);
    const client = this.#sessions.get(task.agentRef);
    if (
      !handle ||
      !client ||
      handle.threadId !== task.threadId ||
      (handle.turnId !== undefined && handle.turnId !== task.turnId)
    ) {
      throw new AgentError(
        'AGENT_INTERACTION_STALE',
        'Interaction handle was lost.',
      );
    }

    let content: Record<string, unknown> | undefined;
    if (input.action === 'accept') {
      if (
        handle.mode === 'form' ||
        handle.mode === 'openai/form' ||
        handle.mode === 'openaiForm'
      ) {
        if (!input.content || !handle.requestedSchema) {
          throw new AgentError(
            'AGENT_INTERACTION_CONTENT_INVALID',
            'Accepted MCP form interactions require validated content.',
          );
        }
        validateMcpFormContent(handle.requestedSchema, input.content);
        content = input.content;
      } else if (handle.mode === 'openai/userVerification') {
        if (!input.content) {
          throw new AgentError(
            'AGENT_INTERACTION_CONTENT_INVALID',
            'Accepted user verification requires proof content.',
          );
        }
        content = input.content;
      } else if (handle.mode === 'url') {
        if (input.content !== undefined) {
          throw new AgentError(
            'AGENT_INTERACTION_CONTENT_INVALID',
            'URL elicitation acceptance does not accept replacement content.',
          );
        }
      } else {
        throw new AgentError(
          'AGENT_INTERACTION_SCHEMA_UNSUPPORTED',
          'Unsupported MCP elicitation mode.',
        );
      }
    } else if (input.content !== undefined) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        'Decline/cancel interactions must not include content.',
      );
    }

    this.#interactions.delete(input.interactionRequestId);
    client.respond(handle.requestId, {
      action: input.action,
      content: content ?? null,
      _meta: null,
    });
    return publicTask(
      await this.#change(task.agentRef, {
        pendingInteraction: undefined,
        status: 'running',
      }),
      true,
    );
  }

  async cancel(input: AgentRefInput): Promise<unknown> {
    let task = this.#require(input.agentRef);
    if (task.terminal) return publicTask(task, true);
    const client = this.#sessions.get(task.agentRef);
    if (!client && this.#releasedRecoveryCandidate(task)) {
      await this.#finalizeReleasedRecovery(
        [task.agentRef],
        'RECOVERY_SESSION_NOT_REATTACHED',
        'stale_cancel',
      );
      task = this.#require(task.agentRef);
      if (task.terminal) return publicTask(task, true);
    }
    if (!task.threadId || !task.turnId || !client) {
      throw new AgentError('AGENT_NOT_IDLE', 'Agent has no active turn.');
    }
    await client.request('turn/interrupt', {
      threadId: task.threadId,
      turnId: task.turnId,
    });
    return publicTask(await this.#refreshActive(task.agentRef, client), true);
  }

  async archive(input: AgentRefInput): Promise<unknown> {
    let task = this.#require(input.agentRef);
    if (!task.terminal || !task.officialSessionReleased || !task.threadId) {
      throw new AgentError(
        'AGENT_NOT_TERMINAL',
        'Agent task is not released terminal.',
      );
    }
    await this.#reconcileMany([task.agentRef]);
    task = this.#require(task.agentRef);
    if (task.archived) return publicTask(task, true);
    let client: AppServerPort | undefined;
    try {
      client = await this.#metadataClient();
      await client.request('thread/archive', { threadId: task.threadId });
      return publicTask(
        await this.#change(task.agentRef, {
          archived: true,
          officialThreadLoadState: 'notLoaded',
        }),
        true,
      );
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async revokeWorkspace(workspaceId: string): Promise<void> {
    const affected = [...this.#tasks.values()].filter(
      (task) => task.workspaceId === workspaceId && !task.archived,
    );
    for (const task of affected) {
      await this.#change(task.agentRef, {
        workspaceAuthorizationStatus: 'revoked',
        latestError: 'WORKSPACE_AUTH_REVOKED',
        lifecycleDiagnostics: diagnostics(task, 'workspace_revoked_by_admin'),
      });
      const client = this.#sessions.get(task.agentRef);
      if (!task.terminal && client && task.threadId && task.turnId) {
        await client
          .request(
            'turn/interrupt',
            { threadId: task.threadId, turnId: task.turnId },
            3_000,
          )
          .catch(() => undefined);
      }
      if (!task.terminal) {
        await this.#change(task.agentRef, {
          status: 'cancelled',
          turnStatus: 'interrupted',
          terminal: true,
          terminalAt: now(),
          repoWriterReleased: false,
        });
      }
      if (client) await this.#releaseSession(task.agentRef, client);
      else {
        await this.#change(task.agentRef, {
          taskAppServerState: 'stopped',
          officialSessionReleased: true,
          officialThreadLoadState: 'notLoaded',
          repoWriterReleased: true,
        });
      }
    }
  }

  async #notification(
    ref: string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const task = this.#tasks.get(ref);
    if (!task) return;
    const event = object(params);
    const threadId = string(event.threadId);
    if (threadId && task.threadId && threadId !== task.threadId) return;
    if (method === 'turn/completed') {
      const turn = object(event.turn);
      if (turn.id !== task.turnId) return;
      const status = turnStatus(turn) ?? 'unknown';
      await this.#recordTerminal(
        ref,
        status === 'completed'
          ? 'completed'
          : status === 'interrupted'
            ? 'cancelled'
            : status === 'failed'
              ? 'failed'
              : 'unknown',
        status,
        turn,
      );
      return;
    }
    if (method === 'item/autoApprovalReview/completed') {
      await this.#change(
        ref,
        {
          lastAutoReview: {
            decision: bounded(
              string(object(event.review).status) ??
                string(event.action) ??
                'unknown',
              120,
            ),
            ...(string(event.decisionSource)
              ? {
                  decisionSource: bounded(
                    string(event.decisionSource) ?? '',
                    120,
                  ),
                }
              : {}),
            observedAt: now(),
          },
        },
        true,
      );
      return;
    }
    if (
      method === 'turn/started' ||
      method === 'item/started' ||
      method === 'item/completed' ||
      method === 'thread/status/changed'
    ) {
      await this.#change(ref, {}, true);
    }
  }

  async #request(
    ref: string,
    client: AppServerPort | undefined,
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    const task = this.#tasks.get(ref);
    const data = object(params);
    if (!client || !task || task.terminal || data.threadId !== task.threadId) {
      client?.respondError(id, -32601, 'Unknown or terminal Agent thread.');
      return;
    }

    if (method === 'mcpServer/elicitation/request') {
      const requestTurnId = string(data.turnId);
      if (requestTurnId && requestTurnId !== task.turnId) {
        client.respondError(id, -32601, 'Stale Localink Agent turn.');
        return;
      }
      if (task.pendingInteraction?.actionable) {
        client.respondError(
          id,
          -32000,
          'Another Agent interaction is already pending.',
        );
        return;
      }
      const serverName = string(data.serverName) ?? 'unknown';
      const rawMode = string(data.mode) ?? 'unknown';
      const mode =
        rawMode === 'form' ||
        rawMode === 'url' ||
        rawMode === 'openai/userVerification' ||
        rawMode === 'openai/form' ||
        rawMode === 'openaiForm'
          ? rawMode
          : 'unknown';
      const interactionRequestId = `interaction_${randomUUID().replaceAll('-', '')}`;
      const requestedSchema = boundedSchema(data.requestedSchema);
      this.#interactions.set(interactionRequestId, {
        requestId: id,
        params: data,
        threadId: task.threadId ?? '',
        ...(requestTurnId ? { turnId: requestTurnId } : {}),
        serverName,
        mode,
        ...(requestedSchema ? { requestedSchema } : {}),
      });
      await this.#change(ref, {
        status: 'awaiting_interaction',
        pendingInteraction: {
          interactionRequestId,
          kind: 'mcp_elicitation',
          serverName: bounded(serverName, 128),
          mode,
          summary: `MCP elicitation requested by ${bounded(serverName, 128)}.`,
          ...(typeof data.message === 'string'
            ? { message: bounded(data.message, 1024) }
            : {}),
          ...(typeof data.url === 'string'
            ? { url: bounded(data.url, 4096) }
            : {}),
          ...(requestedSchema ? { requestedSchema } : {}),
          actionable: true,
        },
      });
      return;
    }

    if (string(data.turnId) !== task.turnId) {
      client.respondError(id, -32601, 'Stale Localink Agent turn.');
      return;
    }
    const kind =
      method === 'item/commandExecution/requestApproval'
        ? 'command'
        : method === 'item/fileChange/requestApproval'
          ? 'file'
          : method === 'item/permissions/requestApproval'
            ? 'permissions'
            : undefined;
    if (!kind) {
      client.respondError(id, -32601, 'Unsupported App Server interaction.');
      await this.#change(ref, {
        status: 'awaiting_interaction',
        pendingInteraction: {
          interactionRequestId: `interaction_${randomUUID().replaceAll('-', '')}`,
          kind: 'unknown',
          mode: 'unknown',
          summary:
            'Unsupported App Server interaction requires native handling.',
          actionable: false,
        },
      });
      return;
    }
    const approvalRequestId = `approval_${randomUUID().replaceAll('-', '')}`;
    this.#handles.set(approvalRequestId, {
      requestId: id,
      method,
      params: data,
      threadId: task.threadId ?? '',
      turnId: task.turnId ?? '',
    });
    await this.#change(ref, {
      status: 'awaiting_approval',
      pendingApproval: {
        approvalRequestId,
        kind,
        summary: `${kind} approval requested by Codex.`,
        actionable: true,
      },
    });
  }
}
