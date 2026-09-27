import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentManager } from '../src/agent-manager.js';
import { AppServerRpcError } from '../src/app-server-client.js';
import type {
  AgentManagerOptions,
  AppServerCallbacks,
  AppServerPort,
} from '../src/types.js';

interface FakeThread {
  id: string;
  cwd: string;
  name?: string;
  section?: { id: string; name: string } | undefined;
  status: { type: 'idle' | 'active' };
  turns: Array<{
    id: string;
    status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
    items: Array<{ type: string; text: string }>;
  }>;
}

class FakeServer implements AppServerPort {
  readonly threads = new Map<string, FakeThread>();
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  readonly responses: Array<{ id: string | number; value: unknown }> = [];
  readonly sections: Array<{ id: string; name: string }> = [];
  callbacks?: AppServerCallbacks;
  starts = 0;
  closed = 0;
  archives = 0;
  permissionMismatch = false;
  sectionFailure = false;
  noExperimentalPermissions = false;
  turnStartUncertain = false;
  nextThread = 0;
  nextTurn = 0;

  bind(callbacks: AppServerCallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  async start(): Promise<void> {
    this.starts++;
  }

  async close(): Promise<void> {
    this.closed++;
  }

  respond(id: string | number, value: unknown): void {
    this.responses.push({ id, value });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.responses.push({ id, value: { code, message } });
  }

  async request(method: string, raw: unknown): Promise<unknown> {
    const params = (raw ?? {}) as Record<string, unknown>;
    this.calls.push({ method, params });
    if (method === 'model/list') {
      return {
        data: [
          {
            id: 'catalog-default',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
          },
        ],
      };
    }
    if (method === 'thread/start') {
      if (this.noExperimentalPermissions && 'permissions' in params) {
        throw new AppServerRpcError(-32602, 'permissions unavailable');
      }
      const id = `thread-${++this.nextThread}`;
      this.threads.set(id, {
        id,
        cwd: String(params.cwd),
        status: { type: 'idle' },
        turns: [],
      });
      return {
        thread: { id },
        activePermissionProfile: {
          id: this.permissionMismatch ? ':danger-full-access' : ':workspace',
        },
        approvalPolicy: 'on-request',
        approvalsReviewer: this.permissionMismatch ? 'user' : 'auto_review',
        sandbox: { type: 'workspaceWrite' },
      };
    }
    if (method === 'threadSection/list') return { data: this.sections };
    if (method === 'threadSection/create') {
      if (this.sectionFailure) throw new Error('Section unavailable');
      const section = { id: 'section-1', name: String(params.name) };
      this.sections.push(section);
      return { section };
    }
    if (method === 'thread/name/set') {
      const thread = this.thread(String(params.threadId));
      thread.name = String(params.name);
      return {};
    }
    if (method === 'thread/section/move') {
      const thread = this.thread(String(params.threadId));
      thread.section = this.sections.find(
        (section) => section.id === params.sectionId,
      );
      return {};
    }
    if (method === 'thread/read') {
      return { thread: this.thread(String(params.threadId)) };
    }
    if (method === 'thread/resume') {
      return {
        thread: this.thread(String(params.threadId)),
        activePermissionProfile: { id: ':workspace' },
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      };
    }
    if (method === 'thread/turns/list') {
      return { data: this.thread(String(params.threadId)).turns };
    }
    if (method === 'turn/start') {
      if (this.turnStartUncertain) {
        throw new Error('The turn/start response was lost.');
      }
      const thread = this.thread(String(params.threadId));
      const turn = {
        id: `turn-${++this.nextTurn}`,
        status: 'inProgress' as const,
        items: [] as Array<{ type: string; text: string }>,
      };
      thread.turns.push(turn);
      thread.status = { type: 'active' };
      return { turn };
    }
    if (method === 'turn/interrupt') {
      const thread = this.thread(String(params.threadId));
      const turn = thread.turns.find((item) => item.id === params.turnId);
      if (turn) turn.status = 'interrupted';
      thread.status = { type: 'idle' };
      return {};
    }
    if (method === 'thread/archive') {
      this.archives++;
      return {};
    }
    throw new Error(`Unexpected fake method: ${method}`);
  }

  thread(id: string): FakeThread {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`Unknown fake thread: ${id}`);
    return thread;
  }

  complete(threadId: string, text = 'FIXED_RESULT'): void {
    const thread = this.thread(threadId);
    const turn = thread.turns.at(-1);
    if (!turn) throw new Error('No fake turn');
    turn.status = 'completed';
    turn.items = [{ type: 'agentMessage', text }];
    thread.status = { type: 'idle' };
    this.callbacks?.onNotification('turn/completed', {
      threadId,
      turn: { ...turn },
    });
  }
}

async function fixture(server = new FakeServer()): Promise<{
  manager: AgentManager;
  server: FakeServer;
  root: string;
  repoA: string;
  repoB: string;
  options: AgentManagerOptions;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-agent-test-'));
  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(repoA);
  await mkdir(repoB);
  const options: AgentManagerOptions = {
    stateRoot: root,
    config: {
      version: 1,
      enabled: true,
      codexExecutable: '/fake/codex',
      permissionPreset: 'auto',
      sectionName: 'Localink Agents',
    },
    resolveWorkspace: async (workspaceId) => ({
      cwd: workspaceId === 'a' ? repoA : repoB,
      workspaceRoot: workspaceId === 'a' ? repoA : repoB,
      workspaceName: workspaceId === 'a' ? 'Workspace A' : 'Workspace B',
    }),
    clientFactory: (callbacks) => server.bind(callbacks),
  };
  const manager = await AgentManager.create(options);
  return {
    manager,
    server,
    root,
    repoA,
    repoB,
    options,
    cleanup: async () => {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

type Receipt = Record<string, unknown>;
const receipt = (value: unknown) => value as Receipt;

test('one managed server owns independent threads, enforces single writer, and releases on terminal without archive', async () => {
  const state = await fixture();
  try {
    const first = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'First task',
        prompt: 'Write a note.',
        supervisionMode: 'detached',
      }),
    );
    assert.equal(state.server.starts, 1);
    assert.equal(first.recommendedAction, 'handoff_to_user');
    assert.deepEqual(first.effectivePermissions, {
      activePermissionProfile: ':workspace',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    });
    assert.deepEqual(first.desktopMirror, {
      status: 'confirmed',
      name: 'First task',
      section: 'Localink Agents',
    });
    await assert.rejects(
      () =>
        state.manager.start({
          workspaceId: 'a',
          taskTitle: 'Second task',
          prompt: 'Write another note.',
        }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_WRITER_CONFLICT',
    );
    const other = receipt(
      await state.manager.start({
        workspaceId: 'b',
        taskTitle: 'Other repo',
        prompt: 'Write in B.',
        supervisionMode: 'inline',
      }),
    );
    assert.equal(state.server.starts, 1);
    assert.notEqual(other.threadId, first.threadId);
    assert.equal(other.recommendedAction, 'wait_bounded');
    const inventory = await stat(
      path.join(state.root, 'state', 'codex-agent-inventory.json'),
    );
    assert.equal(inventory.mode & 0o077, 0);
    state.server.complete(String(first.threadId));
    const done = receipt(
      await state.manager.show({ agentRef: String(first.agentRef) }),
    );
    assert.equal(done.status, 'completed');
    assert.equal(done.writerReleased, true);
    assert.equal(done.archived, false);
    assert.equal(done.finalResult, 'FIXED_RESULT');
    assert.equal(state.server.archives, 0);
    const list = receipt(await state.manager.list({}));
    assert.equal((list.items as unknown[]).length, 2);
    await state.manager.start({
      workspaceId: 'a',
      taskTitle: 'Third task',
      prompt: 'Now allowed.',
    });
    assert.equal(state.server.sections.length, 1);
  } finally {
    await state.cleanup();
  }
});

test('permission mismatch fails before turn and section errors degrade without losing a task', async () => {
  const mismatch = await fixture();
  try {
    mismatch.server.permissionMismatch = true;
    await assert.rejects(
      () =>
        mismatch.manager.start({
          workspaceId: 'a',
          taskTitle: 'Bad permission',
          prompt: 'Never run.',
        }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'PERMISSION_PROFILE_MISMATCH',
    );
    assert.equal(
      mismatch.server.calls.filter((entry) => entry.method === 'turn/start')
        .length,
      0,
    );
    const list = receipt(await mismatch.manager.list({}));
    assert.equal((list.items as Receipt[])[0]?.status, 'failed');
    assert.equal((list.items as Receipt[])[0]?.writerReleased, true);
  } finally {
    await mismatch.cleanup();
  }
  const degraded = await fixture();
  try {
    degraded.server.sectionFailure = true;
    const started = receipt(
      await degraded.manager.start({
        workspaceId: 'a',
        taskTitle: 'Section degraded',
        prompt: 'Still run.',
      }),
    );
    assert.deepEqual(started.desktopMirror, {
      status: 'degraded',
      name: 'Section degraded',
    });
    assert.equal(started.status, 'running');
  } finally {
    await degraded.cleanup();
  }
});

test('official legacy workspace fallback is used only for invalid experimental permissions', async () => {
  const state = await fixture();
  try {
    state.server.noExperimentalPermissions = true;
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Fallback task',
        prompt: 'Do one thing.',
      }),
    );
    assert.equal(started.status, 'running');
    const starts = state.server.calls.filter(
      (entry) => entry.method === 'thread/start',
    );
    assert.equal(starts.length, 2);
    assert.equal(starts[0]?.params.permissions, ':workspace');
    assert.equal(starts[1]?.params.sandbox, 'workspace-write');
    assert.equal(starts[1]?.params.approvalsReviewer, 'auto_review');
  } finally {
    await state.cleanup();
  }
});

test('bounded wait, residual approval, elicitation, and explicit archive remain distinct', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Attention',
        prompt: 'Wait for an action.',
        supervisionMode: 'inline',
      }),
    );
    await assert.rejects(() =>
      state.manager.wait({
        agentRef: String(started.agentRef),
        timeoutMs: 15001,
      }),
    );
    assert.equal(
      receipt(
        await state.manager.wait({
          agentRef: String(started.agentRef),
          timeoutMs: 0,
        }),
      ).recommendedAction,
      'wait_bounded',
    );
    state.server.callbacks?.onRequest(
      17,
      'item/commandExecution/requestApproval',
      {
        threadId: started.threadId,
        turnId: state.server.thread(String(started.threadId)).turns[0]?.id,
        itemId: 'item-1',
        command: 'true',
      },
    );
    let approval: Receipt | undefined;
    for (let i = 0; i < 20; i++) {
      approval = receipt(
        await state.manager.show({ agentRef: String(started.agentRef) }),
      );
      if (approval.pendingApproval) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(approval?.recommendedAction, 'handle_approval');
    const pending = approval?.pendingApproval as Receipt;
    await assert.rejects(() =>
      state.manager.approve({
        agentRef: String(started.agentRef),
        approvalRequestId: 'stale',
      }),
    );
    await state.manager.reject({
      agentRef: String(started.agentRef),
      approvalRequestId: String(pending.approvalRequestId),
    });
    assert.deepEqual(state.server.responses[0], {
      id: 17,
      value: { decision: 'decline' },
    });
    state.server.callbacks?.onRequest(18, 'mcpServer/elicitation/request', {
      mode: 'form',
    });
    for (let i = 0; i < 20; i++) {
      const shown = receipt(
        await state.manager.show({ agentRef: String(started.agentRef) }),
      );
      if (shown.pendingInteraction) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const shown = receipt(
      await state.manager.show({ agentRef: String(started.agentRef) }),
    );
    assert.equal((shown.pendingInteraction as Receipt).kind, 'mcp_elicitation');
    assert.equal(shown.pendingApproval, undefined);
    assert.equal(shown.recommendedAction, 'handoff_to_user');
    assert.equal((state.server.responses[1]?.value as Receipt).code, -32601);
    await assert.rejects(() =>
      state.manager.archive({ agentRef: String(started.agentRef) }),
    );
    state.server.complete(String(started.threadId));
    await state.manager.show({ agentRef: String(started.agentRef) });
    const archived = receipt(
      await state.manager.archive({ agentRef: String(started.agentRef) }),
    );
    assert.equal(archived.archived, true);
    assert.equal(state.server.archives, 1);
  } finally {
    await state.cleanup();
  }
});

test('an uncertain turn/start keeps the repository writer reserved', async () => {
  const state = await fixture();
  try {
    state.server.turnStartUncertain = true;
    await assert.rejects(() =>
      state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Uncertain start',
        prompt: 'Write a note.',
      }),
    );
    const inbox = receipt(await state.manager.list({}));
    const task = (inbox.items as Receipt[])[0];
    assert.equal(task?.status, 'unknown');
    assert.equal(task?.terminal, false);
    assert.equal(task?.writerReleased, false);
    await assert.rejects(
      () =>
        state.manager.start({
          workspaceId: 'a',
          taskTitle: 'Conflicting start',
          prompt: 'Write another note.',
        }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_WRITER_CONFLICT',
    );
  } finally {
    await state.cleanup();
  }
});

test('send resumes an owned idle thread with readback permissions and retains its model', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Follow-up task',
        prompt: 'First turn.',
      }),
    );
    state.server.complete(String(started.threadId), 'FIRST_DONE');
    await state.manager.show({ agentRef: String(started.agentRef) });
    const sent = receipt(
      await state.manager.send({
        agentRef: String(started.agentRef),
        message: 'Second turn.',
      }),
    );
    assert.equal(sent.threadId, started.threadId);
    assert.equal(sent.status, 'running');
    assert.equal(sent.writerReleased, false);
    const resume = state.server.calls.find(
      (entry) => entry.method === 'thread/resume',
    );
    assert.deepEqual(resume?.params, {
      threadId: started.threadId,
      permissions: ':workspace',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      excludeTurns: true,
    });
    const turns = state.server.calls.filter(
      (entry) => entry.method === 'turn/start',
    );
    assert.equal(turns.length, 2);
    assert.equal(turns[1]?.params.model, turns[0]?.params.model);
  } finally {
    await state.cleanup();
  }
});

test('crash hydrates owned work only, lost approvals stay nonactionable, and inbox survives restart', async () => {
  const state = await fixture();
  let replacement: AgentManager | undefined;
  try {
    state.server.threads.set('ordinary-user-thread', {
      id: 'ordinary-user-thread',
      cwd: state.repoA,
      status: { type: 'idle' },
      turns: [],
    });
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Recover me',
        prompt: 'Keep working.',
      }),
    );
    state.server.callbacks?.onRequest(91, 'item/fileChange/requestApproval', {
      threadId: started.threadId,
      turnId: state.server.thread(String(started.threadId)).turns[0]?.id,
      itemId: 'item-approval',
    });
    for (let i = 0; i < 20; i++) {
      const shown = receipt(
        await state.manager.show({ agentRef: String(started.agentRef) }),
      );
      if (shown.pendingApproval) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    state.server.callbacks?.onCrash('fake crash');
    const recovered = receipt(
      await state.manager.show({ agentRef: String(started.agentRef) }),
    );
    assert.equal(state.server.starts, 2);
    assert.equal(recovered.status, 'unknown');
    assert.equal((recovered.pendingApproval as Receipt).actionable, false);
    assert.equal(recovered.writerReleased, false);
    await assert.rejects(() =>
      state.manager.approve({
        agentRef: String(started.agentRef),
        approvalRequestId: String(
          (recovered.pendingApproval as Receipt).approvalRequestId,
        ),
      }),
    );
    const inbox = receipt(await state.manager.list({}));
    assert.equal((inbox.items as Receipt[]).length, 1);
    assert.equal((inbox.items as Receipt[])[0]?.agentRef, started.agentRef);

    state.server.complete(String(started.threadId));
    await state.manager.show({ agentRef: String(started.agentRef) });
    await state.manager.close();
    replacement = await AgentManager.create(state.options);
    const persisted = receipt(await replacement.list({}));
    assert.equal((persisted.items as Receipt[])[0]?.status, 'completed');
    assert.equal((persisted.items as Receipt[])[0]?.archived, false);
  } finally {
    await replacement?.close();
    await state.cleanup();
  }
});
