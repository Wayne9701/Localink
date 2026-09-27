import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AgentInventory } from './agent-inventory.js';
import {
  AppServerRpcError,
  ManagedAppServerClient,
} from './app-server-client.js';
import {
  AgentError,
  type AgentApprovalInput,
  type AgentController,
  type AgentListInput,
  type AgentManagerOptions,
  type AgentRefInput,
  type AgentSendInput,
  type AgentStartInput,
  type AgentStatus,
  type AgentTask,
  type AgentWaitInput,
  type AppServerPort,
} from './types.js';

const execFileAsync = promisify(execFile);
const MAX_TITLE = 160;
const MAX_PROMPT = 16 * 1024;
const MAX_RESULT = 4096;
const MAX_WAIT_MS = 15_000;
const DEFAULT_WAIT_MS = 8_000;
const MAX_RESTARTS = 2;
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

function action(task: AgentTask): string {
  if (task.pendingApproval?.actionable) return 'handle_approval';
  if (task.pendingInteraction) return 'handoff_to_user';
  if (task.terminal) return 'verify_terminal';
  if (task.status === 'unknown') return 'diagnose_uncertain';
  if (task.status === 'failed') return 'diagnose_error';
  if (task.status === 'completed') return 'idle_ready_for_followup';
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
    attention: task.pendingApproval
      ? 'manual_approval'
      : task.pendingInteraction
        ? task.pendingInteraction.kind
        : 'none',
    supervisionMode: task.supervisionMode,
    recommendedAction: action(task),
    terminal: task.terminal,
    writerReleased: task.writerReleased,
    archived: task.archived,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    ...(task.lastProgressAt ? { lastProgressAt: task.lastProgressAt } : {}),
    ...(task.terminalAt ? { terminalAt: task.terminalAt } : {}),
    ...(task.finalResult ? { finalResult: task.finalResult } : {}),
    ...(task.latestError ? { latestError: task.latestError } : {}),
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

export class AgentManager implements AgentController {
  readonly #options: AgentManagerOptions;
  readonly #inventory: AgentInventory;
  readonly #tasks = new Map<string, AgentTask>();
  readonly #handles = new Map<string, ApprovalHandle>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #client: AppServerPort | undefined;
  #clientStart: Promise<AppServerPort> | undefined;
  #sectionId: string | undefined;
  #sectionPromise: Promise<string> | undefined;
  #models: readonly ModelCatalogEntry[] | undefined;
  #restartCount = 0;
  #closed = false;
  #degradedReason: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  private constructor(options: AgentManagerOptions) {
    this.#options = options;
    this.#inventory = new AgentInventory(options.stateRoot);
  }

  static async create(options: AgentManagerOptions): Promise<AgentManager> {
    const manager = new AgentManager(options);
    for (const task of await manager.#inventory.read()) {
      manager.#tasks.set(task.agentRef, task);
    }
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
    const client = this.#client;
    this.#client = undefined;
    if (client) await client.close();
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

  async #change(
    ref: string,
    changes: Partial<AgentTask>,
    progress = false,
  ): Promise<AgentTask> {
    return this.#mutate(async () => {
      const previous = this.#require(ref);
      const next: AgentTask = {
        ...previous,
        ...changes,
        updatedAt: now(),
        nextSeq: previous.nextSeq + 1,
        ...(progress ? { lastProgressAt: now() } : {}),
      };
      this.#tasks.set(ref, next);
      try {
        await this.#inventory.write([...this.#tasks.values()]);
      } catch (error) {
        this.#tasks.set(ref, previous);
        throw error;
      }
      for (const callback of this.#waiters.get(ref) ?? []) callback();
      return next;
    });
  }

  async #ensureClient(): Promise<AppServerPort> {
    if (this.#closed)
      throw new AgentError('AGENT_UNAVAILABLE', 'Manager is closed.');
    if (!this.#options.config.enabled)
      throw new AgentError('AGENT_DISABLED', 'Agent runtime is disabled.');
    if (!this.#options.config.codexExecutable)
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'Codex executable is unavailable.',
      );
    if (this.#client) return this.#client;
    if (this.#clientStart) return this.#clientStart;
    if (this.#restartCount >= MAX_RESTARTS)
      throw new AgentError(
        'AGENT_UNAVAILABLE',
        'App Server restart limit reached.',
      );
    const start = (async () => {
      const callbacks = {
        onNotification: (method: string, params: unknown) => {
          void this.#notification(method, params).catch(() => undefined);
        },
        onRequest: (id: string | number, method: string, params: unknown) => {
          void this.#request(id, method, params).catch(() => {
            try {
              this.#client?.respondError(
                id,
                -32603,
                'Localink could not record the interaction.',
              );
            } catch {
              // A crashed server has no request to answer.
            }
            void this.#markActiveUnknown().catch(() => undefined);
          });
        },
        onCrash: () => {
          this.#client = undefined;
          this.#models = undefined;
          this.#sectionId = undefined;
          this.#sectionPromise = undefined;
          this.#restartCount++;
          this.#degradedReason = 'APP_SERVER_CRASH';
          void this.#markActiveUnknown().catch(() => undefined);
        },
      };
      const client =
        this.#options.clientFactory?.(callbacks) ??
        new ManagedAppServerClient({
          executable: this.#options.config.codexExecutable ?? '',
          ...(this.#options.environment
            ? { environment: this.#options.environment }
            : {}),
          ...callbacks,
        });
      await client.start();
      this.#client = client;
      this.#degradedReason = undefined;
      await this.#tail;
      await this.#hydrate(client);
      return client;
    })();
    this.#clientStart = start;
    try {
      return await start;
    } catch {
      const client = this.#client as AppServerPort | undefined;
      this.#client = undefined;
      if (client) await client.close().catch(() => undefined);
      this.#restartCount++;
      this.#degradedReason = 'APP_SERVER_START_FAILED';
      throw new AgentError('AGENT_UNAVAILABLE', 'App Server could not start.');
    } finally {
      this.#clientStart = undefined;
    }
  }

  async #markActiveUnknown(): Promise<void> {
    for (const task of this.#tasks.values()) {
      if (task.archived || task.terminal) continue;
      await this.#change(task.agentRef, {
        status: 'unknown',
        lifecycleIntegrity: 'uncertain',
        pendingApproval: task.pendingApproval
          ? { ...task.pendingApproval, actionable: false }
          : undefined,
        latestError: 'APP_SERVER_CRASH',
      });
    }
    this.#handles.clear();
  }

  async #hydrate(client: AppServerPort): Promise<void> {
    for (const task of this.#tasks.values()) {
      if (task.archived || task.terminal) continue;
      if (task.writerReleased) {
        await this.#change(task.agentRef, {
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'LIFECYCLE_INTEGRITY_UNCERTAIN',
        });
        continue;
      }
      if (task.pendingApproval) {
        await this.#change(task.agentRef, {
          pendingApproval: { ...task.pendingApproval, actionable: false },
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'APPROVAL_HANDLE_LOST',
        });
      }
      await this.#refresh(task.agentRef, client).catch(async () => {
        await this.#change(task.agentRef, {
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'OFFICIAL_READBACK_UNAVAILABLE',
        });
      });
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
          if (!id) break;
          this.#sectionId = id;
          return id;
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
    try {
      await client.request('thread/name/set', {
        threadId: task.threadId,
        name: task.taskTitle,
      });
      const sectionId = await this.#ensureSection(client);
      await client.request('thread/section/move', {
        threadId: task.threadId,
        sectionId,
      });
      const read = object(
        await client.request('thread/read', { threadId: task.threadId }),
      );
      const thread = object(read.thread);
      const section = object(thread.section);
      if (
        thread.name !== task.taskTitle ||
        section.id !== sectionId ||
        section.name !== this.#options.config.sectionName
      ) {
        throw new Error('Section readback mismatch.');
      }
      await this.#change(ref, {
        desktopMirror: {
          status: 'confirmed',
          name: task.taskTitle,
          section: this.#options.config.sectionName,
        },
      });
    } catch {
      await this.#change(ref, {
        desktopMirror: { status: 'degraded', name: task.taskTitle },
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
    const client = await this.#ensureClient();
    const workspace = await this.#options.resolveWorkspace(
      input.workspaceId,
      input.relativeCwd,
    );
    const key = await repoKey(workspace.cwd, workspace.workspaceRoot);
    const choice = await this.#model(
      client,
      input.model,
      input.reasoningEffort,
      input.invocationRationale,
    );
    const timestamp = now();
    const initial: AgentTask = {
      agentRef: `agent_${randomUUID().replaceAll('-', '')}`,
      taskTitle: input.taskTitle.trim(),
      workspaceId: input.workspaceId,
      workspaceName: workspace.workspaceName,
      relativeCwd: input.relativeCwd ?? '',
      canonicalRepoRoot: key,
      repo: path.basename(key),
      supervisionMode: input.supervisionMode ?? 'auto',
      model: choice.model,
      reasoningEffort: choice.effort,
      permissionPreset: 'auto',
      status: 'starting',
      terminal: false,
      writerReleased: false,
      archived: false,
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
          !task.writerReleased &&
          task.canonicalRepoRoot === key,
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
        await this.#inventory.write([...this.#tasks.values()]);
      } catch (error) {
        this.#tasks.delete(initial.agentRef);
        throw error;
      }
    });
    let turnStartAttempted = false;
    try {
      const started = await this.#threadStart(
        client,
        workspace.cwd,
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
          input: [{ type: 'text', text: input.prompt, text_elements: [] }],
          model: choice.model,
          effort: choice.effort,
        }),
      );
      const turnId = string(object(response.turn).id);
      if (!turnId) throw new Error('Turn start returned no ID.');
      const task = await this.#change(
        initial.agentRef,
        { turnId, status: 'running' },
        true,
      );
      return publicTask(task, true);
    } catch (error) {
      const code =
        error instanceof AgentError ? error.code : 'AGENT_START_FAILED';
      const orphanThreadId =
        error instanceof AgentError
          ? string(error.details?.threadId)
          : undefined;
      await this.#change(initial.agentRef, {
        ...(orphanThreadId ? { threadId: orphanThreadId } : {}),
        status: turnStartAttempted ? 'unknown' : 'failed',
        terminal: !turnStartAttempted,
        writerReleased: !turnStartAttempted,
        lifecycleIntegrity: turnStartAttempted ? 'uncertain' : 'confirmed',
        ...(turnStartAttempted ? {} : { terminalAt: now() }),
        latestError: turnStartAttempted ? 'TURN_START_UNCERTAIN' : code,
      });
      throw error;
    }
  }

  async #refresh(ref: string, client: AppServerPort): Promise<AgentTask> {
    const task = this.#require(ref);
    if (!task.threadId || task.archived || task.terminal) return task;
    const read = object(
      await client.request('thread/read', { threadId: task.threadId }),
    );
    const thread = object(read.thread);
    if (thread.id !== task.threadId) {
      throw new AgentError(
        'AGENT_STATE_UNKNOWN',
        'Official thread identity mismatch.',
      );
    }
    const turns = object(
      await client.request('thread/turns/list', {
        threadId: task.threadId,
        limit: 20,
        itemsView: 'full',
      }),
    );
    const entries = Array.isArray(turns.data) ? turns.data : [];
    const turn = entries.map(object).find((entry) => entry.id === task.turnId);
    if (!turn) {
      return this.#change(ref, {
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
      const mapped: AgentStatus =
        status === 'completed'
          ? 'completed'
          : status === 'interrupted'
            ? 'cancelled'
            : 'failed';
      return this.#change(ref, {
        status: mapped,
        terminal: true,
        writerReleased: true,
        terminalAt: now(),
        finalResult: finalMessage(turn) ?? task.finalResult,
        latestError:
          status === 'failed' ? 'CODEX_TURN_FAILED' : task.latestError,
        lifecycleIntegrity: 'confirmed',
        pendingApproval: undefined,
      });
    }
    if (status === 'inProgress') {
      if (task.writerReleased) {
        return this.#change(ref, {
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'LIFECYCLE_INTEGRITY_UNCERTAIN',
        });
      }
      return task.status === 'unknown' &&
        !task.pendingInteraction &&
        !task.pendingApproval &&
        object(thread.status).type === 'active'
        ? this.#change(ref, {
            status: 'running',
            lifecycleIntegrity: 'confirmed',
            latestError: undefined,
          })
        : task;
    }
    return this.#change(ref, {
      status: 'unknown',
      lifecycleIntegrity: 'uncertain',
      latestError: 'TURN_STATUS_UNKNOWN',
    });
  }

  async list(input: AgentListInput = {}): Promise<unknown> {
    if (
      this.#options.config.enabled &&
      [...this.#tasks.values()].some((task) => !task.terminal && !task.archived)
    ) {
      await this.#ensureClient().catch(async () => {
        await this.#markActiveUnknown();
      });
    }
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
    if (!task.terminal && task.threadId && this.#options.config.enabled) {
      try {
        const client = await this.#ensureClient();
        task = await this.#refresh(task.agentRef, client);
      } catch {
        task = await this.#change(task.agentRef, {
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'OFFICIAL_READBACK_UNAVAILABLE',
        });
      }
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
    if (!task.terminal && task.threadId && this.#options.config.enabled) {
      try {
        const client = await this.#ensureClient();
        task = await this.#refresh(task.agentRef, client);
      } catch {
        task = await this.#change(task.agentRef, {
          status: 'unknown',
          lifecycleIntegrity: 'uncertain',
          latestError: 'OFFICIAL_READBACK_UNAVAILABLE',
        });
      }
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
    if (!task.threadId || task.archived || task.status !== 'completed') {
      throw new AgentError('AGENT_NOT_IDLE', 'Agent is not idle.');
    }
    const client = await this.#ensureClient();
    const read = object(
      await client.request('thread/read', { threadId: task.threadId }),
    );
    if (object(object(read.thread).status).type !== 'idle') {
      throw new AgentError('AGENT_NOT_IDLE', 'Official thread is not idle.');
    }
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
    await this.#mutate(async () => {
      const conflict = [...this.#tasks.values()].find(
        (other) =>
          other.agentRef !== task.agentRef &&
          !other.archived &&
          !other.writerReleased &&
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
        terminal: false,
        writerReleased: false,
        terminalAt: undefined,
        finalResult: undefined,
        latestError: undefined,
        updatedAt: now(),
      };
      this.#tasks.set(task.agentRef, task);
      await this.#inventory.write([...this.#tasks.values()]);
    });
    try {
      const response = object(
        await client.request('turn/start', {
          threadId: task.threadId,
          input: [{ type: 'text', text: input.message, text_elements: [] }],
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
            model: choice.model,
            reasoningEffort: choice.effort,
            status: 'running',
          },
          true,
        ),
        true,
      );
    } catch {
      await this.#change(task.agentRef, {
        status: 'unknown',
        lifecycleIntegrity: 'uncertain',
        latestError: 'TURN_START_UNCERTAIN',
      });
      throw new AgentError(
        'AGENT_STATE_UNKNOWN',
        'Turn start could not be confirmed.',
      );
    }
  }

  async #approval(
    input: AgentApprovalInput,
    decision: 'accept' | 'decline',
  ): Promise<unknown> {
    const task = this.#require(input.agentRef);
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
    if (
      !handle ||
      handle.threadId !== task.threadId ||
      handle.turnId !== task.turnId
    ) {
      throw new AgentError('AGENT_APPROVAL_STALE', 'Approval handle was lost.');
    }
    const client = await this.#ensureClient();
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

  async cancel(input: AgentRefInput): Promise<unknown> {
    const task = this.#require(input.agentRef);
    if (task.terminal || !task.threadId || !task.turnId) {
      throw new AgentError('AGENT_NOT_IDLE', 'Agent has no active turn.');
    }
    const client = await this.#ensureClient();
    await client.request('turn/interrupt', {
      threadId: task.threadId,
      turnId: task.turnId,
    });
    return publicTask(await this.#refresh(task.agentRef, client), true);
  }

  async archive(input: AgentRefInput): Promise<unknown> {
    const task = this.#require(input.agentRef);
    if (!task.terminal || !task.writerReleased || !task.threadId) {
      throw new AgentError('AGENT_NOT_TERMINAL', 'Agent task is not terminal.');
    }
    if (task.archived) return publicTask(task, true);
    const client = await this.#ensureClient();
    await client.request('thread/archive', { threadId: task.threadId });
    return publicTask(
      await this.#change(task.agentRef, { archived: true }),
      true,
    );
  }

  async #notification(method: string, params: unknown): Promise<void> {
    const event = object(params);
    const threadId = string(event.threadId);
    if (!threadId) return;
    const task = [...this.#tasks.values()].find(
      (entry) => entry.threadId === threadId && !entry.archived,
    );
    if (!task) return;
    if (method === 'turn/completed') {
      const turn = object(event.turn);
      if (turn.id !== task.turnId) return;
      const status = turnStatus(turn);
      const mapped: AgentStatus =
        status === 'completed'
          ? 'completed'
          : status === 'interrupted'
            ? 'cancelled'
            : status === 'failed'
              ? 'failed'
              : 'unknown';
      await this.#change(
        task.agentRef,
        {
          status: mapped,
          terminal: isTerminal(mapped),
          writerReleased: isTerminal(mapped),
          ...(isTerminal(mapped) ? { terminalAt: now() } : {}),
          finalResult: finalMessage(turn) ?? task.finalResult,
          pendingApproval: undefined,
          latestError:
            mapped === 'failed' ? 'CODEX_TURN_FAILED' : task.latestError,
          lifecycleIntegrity: mapped === 'unknown' ? 'uncertain' : 'confirmed',
        },
        true,
      );
      return;
    }
    if (method === 'item/autoApprovalReview/completed') {
      await this.#change(
        task.agentRef,
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
      await this.#change(task.agentRef, {}, true);
    }
  }

  async #request(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    const data = object(params);
    const threadId = string(data.threadId);
    const client = this.#client;
    if (method === 'mcpServer/elicitation/request') {
      client?.respondError(
        id,
        -32601,
        'MCP elicitation requires native handling.',
      );
      const candidates = [...this.#tasks.values()].filter(
        (entry) =>
          !entry.archived &&
          !entry.terminal &&
          (!threadId || entry.threadId === threadId),
      );
      for (const candidate of candidates) {
        await this.#change(candidate.agentRef, {
          status: candidates.length === 1 ? 'awaiting_interaction' : 'unknown',
          ...(candidates.length === 1
            ? {}
            : {
                lifecycleIntegrity: 'uncertain' as const,
                latestError: 'ELICITATION_OWNER_AMBIGUOUS',
              }),
          pendingInteraction: {
            kind: 'mcp_elicitation',
            summary: 'MCP elicitation requires native user handling.',
          },
        });
      }
      return;
    }
    const task = [...this.#tasks.values()].find(
      (entry) => entry.threadId === threadId && !entry.archived,
    );
    if (!client || !task || !threadId || task.terminal) {
      client?.respondError(
        id,
        -32601,
        'Unknown or terminal Localink Agent thread.',
      );
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
      await this.#change(task.agentRef, {
        status: 'awaiting_interaction',
        pendingInteraction: {
          kind: 'unknown',
          summary:
            'Unsupported App Server interaction requires native handling.',
        },
      });
      return;
    }
    const approvalRequestId = `approval_${randomUUID().replaceAll('-', '')}`;
    this.#handles.set(approvalRequestId, {
      requestId: id,
      method,
      params: data,
      threadId,
      turnId: string(data.turnId) ?? '',
    });
    await this.#change(task.agentRef, {
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
