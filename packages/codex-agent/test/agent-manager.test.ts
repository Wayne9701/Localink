import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentManager } from '../src/agent-manager.js';
import type {
  AgentManagerOptions,
  AppServerCallbacks,
  AppServerPort,
} from '../src/types.js';

interface FakeTurn {
  id: string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  items: Array<{ type: string; text: string }>;
}

interface FakeThread {
  id: string;
  cwd: string;
  name?: string;
  section?: { id: string; name: string };
  turns: FakeTurn[];
}

class FakeOfficialState {
  readonly threads = new Map<string, FakeThread>();
  readonly archived = new Set<string>();
  readonly sections: Array<{ id: string; name: string }> = [];
  readonly servers: FakeServer[] = [];
  nextThread = 0;
  nextTurn = 0;
  projectionCalls = 0;

  latest(ref: string): FakeServer {
    const server = [...this.servers]
      .reverse()
      .find((candidate) => candidate.agentRef === ref);
    if (!server) throw new Error(`No server for ${ref}`);
    return server;
  }

  taskServers(): FakeServer[] {
    return this.servers.filter((server) => server.agentRef !== 'metadata');
  }
}

class FakeServer implements AppServerPort {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  readonly responses: Array<{ id: string | number; value: unknown }> = [];
  starts = 0;
  closes = 0;
  failClose = false;
  permissionMismatch = false;
  sectionFailure = false;
  turnStartUncertain = false;
  crashOnInterrupt = false;

  constructor(
    readonly state: FakeOfficialState,
    readonly agentRef: string,
    readonly callbacks: AppServerCallbacks,
    readonly launchArgs: readonly string[],
  ) {}

  async start(): Promise<void> {
    this.starts++;
  }

  processId(): number | undefined {
    return undefined;
  }

  async close(): Promise<void> {
    this.closes++;
    if (this.failClose) throw new Error('fixture teardown failure');
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
      const id = `thread-${++this.state.nextThread}`;
      this.state.threads.set(id, {
        id,
        cwd: String(params.cwd),
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
    if (method === 'threadSection/list') return { data: this.state.sections };
    if (method === 'threadSection/create') {
      if (this.sectionFailure) throw new Error('section unavailable');
      const section = { id: 'section-1', name: String(params.name) };
      this.state.sections.push(section);
      return { section };
    }
    if (method === 'thread/name/set') {
      this.thread(String(params.threadId)).name = String(params.name);
      return {};
    }
    if (method === 'thread/section/move') {
      const section = this.state.sections.find(
        (section) => section.id === params.sectionId,
      );
      if (section) this.thread(String(params.threadId)).section = section;
      return {};
    }
    if (method === 'thread/read') {
      const thread = this.thread(String(params.threadId));
      const active = thread.turns.at(-1)?.status === 'inProgress';
      return {
        thread: {
          ...thread,
          status: { type: active ? 'active' : 'idle' },
        },
      };
    }
    if (method === 'thread/resume') {
      const thread = this.thread(String(params.threadId));
      return {
        thread: { ...thread, status: { type: 'idle' } },
        activePermissionProfile: { id: ':workspace' },
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
      };
    }
    if (method === 'thread/turns/list') {
      return { data: this.thread(String(params.threadId)).turns };
    }
    if (method === 'turn/start') {
      if (this.turnStartUncertain) throw new Error('lost turn/start response');
      const thread = this.thread(String(params.threadId));
      const turn: FakeTurn = {
        id: `turn-${++this.state.nextTurn}`,
        status: 'inProgress',
        items: [],
      };
      thread.turns.push(turn);
      return { turn };
    }
    if (method === 'turn/interrupt') {
      const turn = this.thread(String(params.threadId)).turns.find(
        (candidate) => candidate.id === params.turnId,
      );
      if (turn) turn.status = 'interrupted';
      if (this.crashOnInterrupt) {
        this.callbacks.onCrash('exit code=null signal=SIGTERM');
      }
      return {};
    }
    if (method === 'thread/list') {
      const archived = params.archived === true;
      const data = [...this.state.threads.values()]
        .filter((thread) => this.state.archived.has(thread.id) === archived)
        .map((thread) => ({
          id: thread.id,
          cwd: thread.cwd,
          name: thread.name,
          section: thread.section,
          status: { type: 'notLoaded' },
          updatedAt: '2026-09-28T00:00:00.000Z',
        }));
      return { data, nextCursor: null };
    }
    if (method === 'thread/archive') {
      this.state.archived.add(String(params.threadId));
      return {};
    }
    throw new Error(`Unexpected fake method: ${method}`);
  }

  thread(id: string): FakeThread {
    const thread = this.state.threads.get(id);
    if (!thread) throw new Error(`Unknown fake thread: ${id}`);
    return thread;
  }

  complete(text = 'FIXED_RESULT'): void {
    const thread = [...this.state.threads.values()].find((candidate) =>
      candidate.turns.some((turn) => turn.status === 'inProgress'),
    );
    if (!thread) throw new Error('No active turn');
    const turn = thread.turns.at(-1);
    if (!turn) throw new Error('No turn');
    turn.status = 'completed';
    turn.items = [{ type: 'agentMessage', text }];
    this.callbacks.onNotification('turn/completed', {
      threadId: thread.id,
      turn: { ...turn },
    });
  }

  crash(reason = 'fixture App Server crash'): void {
    this.callbacks.onCrash(reason);
  }

  requestApproval(): void {
    const thread = [...this.state.threads.values()].find((candidate) =>
      candidate.turns.some((turn) => turn.status === 'inProgress'),
    );
    const turn = thread?.turns.at(-1);
    if (!thread || !turn) throw new Error('No active turn');
    this.callbacks.onRequest(17, 'item/commandExecution/requestApproval', {
      threadId: thread.id,
      turnId: turn.id,
      itemId: 'item-1',
      command: 'true',
    });
  }

  requestFormElicitation(): void {
    const thread = [...this.state.threads.values()].find((candidate) =>
      candidate.turns.some((turn) => turn.status === 'inProgress'),
    );
    const turn = thread?.turns.at(-1);
    if (!thread || !turn) throw new Error('No active turn');
    this.callbacks.onRequest(23, 'mcpServer/elicitation/request', {
      threadId: thread.id,
      turnId: turn.id,
      serverName: 'bigquery',
      mode: 'form',
      message: 'Choose a bounded option.',
      requestedSchema: {
        type: 'object',
        properties: {
          choice: { type: 'string', enum: ['one', 'two'] },
        },
        required: ['choice'],
      },
    });
  }

  requestUrlElicitation(): void {
    const thread = [...this.state.threads.values()].find((candidate) =>
      candidate.turns.some((turn) => turn.status === 'inProgress'),
    );
    const turn = thread?.turns.at(-1);
    if (!thread || !turn) throw new Error('No active turn');
    this.callbacks.onRequest(24, 'mcpServer/elicitation/request', {
      threadId: thread.id,
      turnId: turn.id,
      serverName: 'singular',
      mode: 'url',
      message: 'Open the exact authorization URL.',
      url: 'https://example.invalid/exact',
      elicitationId: 'url-1',
    });
  }
}

interface Fixture {
  manager: AgentManager;
  options: AgentManagerOptions;
  official: FakeOfficialState;
  roots: Map<string, string>;
  generations: Map<string, string>;
  root: string;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-agent-test-'));
  const repoA = path.join(root, 'repo-a');
  const repoB = path.join(root, 'repo-b');
  await mkdir(repoA);
  await mkdir(repoB);
  const roots = new Map([
    ['a', repoA],
    ['b', repoB],
  ]);
  const generations = new Map([
    ['a', 'generation-1'],
    ['b', 'generation-1'],
  ]);
  const official = new FakeOfficialState();
  const options: AgentManagerOptions = {
    stateRoot: root,
    config: {
      version: 1,
      enabled: true,
      codexExecutable: '/fake/codex',
      permissionPreset: 'auto',
      sectionName: 'Localink Agents',
    },
    resolveWorkspace: async (workspaceId) => {
      const workspaceRoot = roots.get(workspaceId);
      const authorizationGeneration = generations.get(workspaceId);
      if (!workspaceRoot || !authorizationGeneration)
        throw new Error('revoked');
      return {
        cwd: workspaceRoot,
        workspaceRoot,
        workspaceName: `Workspace ${workspaceId.toUpperCase()}`,
        authorizationGeneration,
      };
    },
    capabilityProjector: async () => {
      official.projectionCalls++;
      return {
        launchArgs: ['-c', 'mcp_servers.engineering-bridge.enabled=false'],
      };
    },
    clientFactory: (callbacks, launch) => {
      const server = new FakeServer(
        official,
        launch.agentRef,
        callbacks,
        launch.args,
      );
      official.servers.push(server);
      return server;
    },
  };
  const manager = await AgentManager.create(options);
  return {
    manager,
    options,
    official,
    roots,
    generations,
    root,
    cleanup: async () => {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

type Receipt = Record<string, unknown>;
const receipt = (value: unknown) => value as Receipt;

async function eventually(
  read: () => Promise<Receipt>,
  predicate: (value: Receipt) => boolean,
): Promise<Receipt> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

test('each active Agent owns one task App Server and different repos run in parallel', async () => {
  const state = await fixture();
  try {
    const first = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'First',
        prompt: 'First prompt',
        supervisionMode: 'detached',
      }),
    );
    await assert.rejects(
      state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Conflict',
        prompt: 'Conflict prompt',
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_WRITER_CONFLICT',
    );
    const second = receipt(
      await state.manager.start({
        workspaceId: 'b',
        taskTitle: 'Second',
        prompt: 'Second prompt',
      }),
    );
    assert.notEqual(first.agentRef, second.agentRef);
    assert.equal(state.official.taskServers().length, 2);
    assert.equal(state.official.projectionCalls, 2);
    assert.notEqual(
      state.official.latest(String(first.agentRef)),
      state.official.latest(String(second.agentRef)),
    );
    assert.equal(
      state.official.threads.get(String(first.threadId))?.name,
      '[Localink] First',
    );
    assert.equal((first.desktopMirror as Receipt).name, '[Localink] First');
  } finally {
    await state.cleanup();
  }
});

test('execution contract is a stable suffix that preserves start and send user tasks', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Contract',
        prompt: 'Exact user start task',
      }),
    );
    const firstServer = state.official.latest(String(started.agentRef));
    const firstTurn = firstServer.calls.find(
      (call) => call.method === 'turn/start',
    );
    const firstText = String(
      ((firstTurn?.params.input as Array<Record<string, unknown>>)[0] ?? {})
        .text,
    );
    assert.ok(firstText.startsWith('Exact user start task\n\n'));
    assert.ok(firstText.endsWith('</localink_execution_contract>'));
    assert.match(firstText, /Keep verbose test stdout\/stderr/);
    assert.match(firstText, /external supervisor after this Agent is terminal/);

    firstServer.complete();
    await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => value.officialSessionReleased === true,
    );
    await state.manager.send({
      agentRef: String(started.agentRef),
      message: 'Exact follow-up task',
    });
    const resumedServer = state.official.latest(String(started.agentRef));
    const resumedTurn = resumedServer.calls.find(
      (call) => call.method === 'turn/start',
    );
    const resumedText = String(
      ((resumedTurn?.params.input as Array<Record<string, unknown>>)[0] ?? {})
        .text,
    );
    assert.ok(resumedText.startsWith('Exact follow-up task\n\n'));
    assert.ok(resumedText.endsWith('</localink_execution_contract>'));
  } finally {
    await state.cleanup();
  }
});

test('terminal persists before teardown and releases the repo only after process exit', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Complete',
        prompt: 'Complete prompt',
      }),
    );
    state.official.latest(String(started.agentRef)).complete('DONE');
    const done = await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => value.officialSessionReleased === true,
    );
    assert.equal(done.status, 'completed');
    assert.equal(done.repoWriterReleased, true);
    assert.equal(done.taskAppServerState, 'stopped');
    assert.equal(done.officialThreadLoadState, 'notLoaded');
    assert.equal(done.archived, false);
    assert.equal(done.desktopHistoryReady, true);
    await state.manager.start({
      workspaceId: 'a',
      taskTitle: 'Next',
      prompt: 'Now allowed',
    });
  } finally {
    await state.cleanup();
  }
});

test('large official output is bounded in public receipts and durable inventory', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Large result',
        prompt: 'Return a large fixture result',
      }),
    );
    state.official
      .latest(String(started.agentRef))
      .complete('x'.repeat(2 * 1024 * 1024));
    const done = await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => value.officialSessionReleased === true,
    );
    assert.ok(Buffer.byteLength(String(done.finalResult)) <= 4100);
    const inventory = await readFile(
      path.join(state.root, 'state', 'codex-agent-inventory.json'),
    );
    assert.ok(inventory.byteLength < 64 * 1024);
  } finally {
    await state.cleanup();
  }
});

test('protocol crash releases ownership and terminalizes as bounded recovery failure', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Protocol crash',
        prompt: 'Stay active until the fixture crashes',
      }),
    );
    const server = state.official.latest(String(started.agentRef));
    server.crash('App Server stdout line limit exceeded');
    const failed = await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => value.terminal === true,
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.taskStatus, 'failed');
    assert.equal(failed.turnStatus, 'failed');
    assert.equal(failed.lifecycleIntegrity, 'recovery_failed');
    assert.equal(failed.latestError, 'APP_SERVER_PROTOCOL_LIMIT_EXCEEDED');
    assert.equal(failed.officialSessionReleased, true);
    assert.equal(failed.repoWriterReleased, true);
    assert.equal(failed.taskAppServerState, 'stopped');
    assert.equal(failed.recommendedAction, 'archive');
    assert.equal(server.closes, 1);
  } finally {
    await state.cleanup();
  }
});

for (const officialStatus of ['completed', 'failed', 'interrupted'] as const) {
  test(`official ${officialStatus} truth wins after App Server loss`, async () => {
    const state = await fixture();
    try {
      const started = receipt(
        await state.manager.start({
          workspaceId: 'a',
          taskTitle: `Official ${officialStatus}`,
          prompt: 'Lose the transport after official termination',
        }),
      );
      const server = state.official.latest(String(started.agentRef));
      const turn = server.thread(String(started.threadId)).turns.at(-1);
      assert.ok(turn);
      turn.status = officialStatus;
      turn.items = [
        { type: 'agentMessage', text: `OFFICIAL_${officialStatus}` },
      ];
      server.crash('fixture transport loss');
      const terminal = await eventually(
        () =>
          state.manager.show({
            agentRef: String(started.agentRef),
          }) as Promise<Receipt>,
        (value) => value.terminal === true,
      );
      assert.equal(
        terminal.status,
        officialStatus === 'completed'
          ? 'completed'
          : officialStatus === 'interrupted'
            ? 'cancelled'
            : 'failed',
      );
      assert.equal(terminal.turnStatus, officialStatus);
      assert.equal(terminal.lifecycleIntegrity, 'confirmed');
      assert.equal(terminal.finalResult, `OFFICIAL_${officialStatus}`);
      assert.equal(terminal.officialSessionReleased, true);
      assert.equal(terminal.repoWriterReleased, true);
    } finally {
      await state.cleanup();
    }
  });
}

test('teardown failure keeps the same-repo writer lock and blocks archive', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Release pending',
        prompt: 'Complete prompt',
      }),
    );
    const server = state.official.latest(String(started.agentRef));
    server.failClose = true;
    server.complete();
    const pending = await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => value.taskAppServerState === 'release_pending',
    );
    assert.equal(pending.repoWriterReleased, false);
    assert.equal(pending.officialSessionReleased, false);
    await assert.rejects(
      state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Blocked',
        prompt: 'Must remain blocked',
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_WRITER_CONFLICT',
    );
    await assert.rejects(
      state.manager.archive({ agentRef: String(started.agentRef) }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_NOT_TERMINAL',
    );
  } finally {
    state.official.servers.forEach((server) => {
      server.failClose = false;
    });
    await state.cleanup();
  }
});

test('codex-native-v1 inherits Codex capabilities and excludes only Engineering Bridge', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Isolated',
        prompt: 'Isolated prompt',
      }),
    );
    const args = state.official.latest(String(started.agentRef)).launchArgs;
    assert.equal(args.includes('features.plugins=false'), false);
    assert.equal(args.includes('features.computer_use=false'), false);
    assert.ok(args.includes('mcp_servers.engineering-bridge.enabled=false'));
    assert.equal(started.capabilityProfile, 'codex-native-v1');
  } finally {
    await state.cleanup();
  }
});

test('MCP form elicitation becomes one exact validated Agent interaction', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Form elicitation',
        prompt: 'Use one MCP.',
      }),
    );
    const server = state.official.latest(String(started.agentRef));
    server.requestFormElicitation();
    const waiting = await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => typeof value.pendingInteraction === 'object',
    );
    const interaction = waiting.pendingInteraction as Receipt;
    assert.equal(waiting.status, 'awaiting_interaction');
    assert.equal(interaction.kind, 'mcp_elicitation');
    assert.equal(interaction.serverName, 'bigquery');
    assert.equal(interaction.mode, 'form');
    assert.equal(interaction.actionable, true);
    const interactionRequestId = String(interaction.interactionRequestId);

    await assert.rejects(
      state.manager.interact({
        agentRef: String(started.agentRef),
        interactionRequestId,
        action: 'accept',
        content: { choice: 'three' },
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_INTERACTION_CONTENT_INVALID',
    );

    const resumed = receipt(
      await state.manager.interact({
        agentRef: String(started.agentRef),
        interactionRequestId,
        action: 'accept',
        content: { choice: 'one' },
      }),
    );
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.pendingInteraction, undefined);
    assert.deepEqual(server.responses.at(-1), {
      id: 23,
      value: { action: 'accept', content: { choice: 'one' }, _meta: null },
    });
    await assert.rejects(
      state.manager.interact({
        agentRef: String(started.agentRef),
        interactionRequestId,
        action: 'decline',
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_INTERACTION_STALE',
    );
  } finally {
    await state.cleanup();
  }
});

test('MCP URL elicitation preserves the exact server URL and accepts no replacement content', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'URL elicitation',
        prompt: 'Use one MCP.',
      }),
    );
    const server = state.official.latest(String(started.agentRef));
    server.requestUrlElicitation();
    const waiting = await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => typeof value.pendingInteraction === 'object',
    );
    const interaction = waiting.pendingInteraction as Receipt;
    assert.equal(interaction.serverName, 'singular');
    assert.equal(interaction.mode, 'url');
    assert.equal(interaction.url, 'https://example.invalid/exact');
    const interactionRequestId = String(interaction.interactionRequestId);

    await assert.rejects(
      state.manager.interact({
        agentRef: String(started.agentRef),
        interactionRequestId,
        action: 'accept',
        content: { url: 'https://attacker.invalid' },
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_INTERACTION_CONTENT_INVALID',
    );
    await state.manager.interact({
      agentRef: String(started.agentRef),
      interactionRequestId,
      action: 'accept',
    });
    assert.deepEqual(server.responses.at(-1), {
      id: 24,
      value: { action: 'accept', content: null, _meta: null },
    });
  } finally {
    await state.cleanup();
  }
});

test('ten sequential terminal tasks deterministically tear down without session accumulation', async () => {
  const state = await fixture();
  try {
    const completed: Receipt[] = [];
    for (let index = 1; index <= 10; index++) {
      const started = receipt(
        await state.manager.start({
          workspaceId: 'a',
          taskTitle: `Tiny ${index}`,
          prompt: 'Complete immediately',
        }),
      );
      const server = state.official.latest(String(started.agentRef));
      server.complete(`DONE_${index}`);
      completed.push(
        await eventually(
          () =>
            state.manager.show({
              agentRef: String(started.agentRef),
            }) as Promise<Receipt>,
          (value) => value.officialSessionReleased === true,
        ),
      );
      assert.equal(server.starts, 1);
      assert.equal(server.closes, 1);
    }
    assert.equal(state.official.taskServers().length, 10);
    assert.equal(
      state.official.taskServers().filter((server) => server.closes === 1)
        .length,
      10,
    );
    assert.ok(
      completed.every(
        (task) =>
          task.status === 'completed' &&
          task.taskAppServerState === 'stopped' &&
          task.officialSessionReleased === true &&
          task.repoWriterReleased === true,
      ),
    );
  } finally {
    await state.cleanup();
  }
});

test('revoked Workspace blocks send and approval while reject remains cleanup-safe', async () => {
  const state = await fixture();
  try {
    const completed = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Resume target',
        prompt: 'First turn',
      }),
    );
    state.official.latest(String(completed.agentRef)).complete();
    await eventually(
      () =>
        state.manager.show({
          agentRef: String(completed.agentRef),
        }) as Promise<Receipt>,
      (value) => value.officialSessionReleased === true,
    );
    state.roots.delete('a');
    state.generations.delete('a');
    await assert.rejects(
      state.manager.send({
        agentRef: String(completed.agentRef),
        message: 'Forbidden resume',
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORKSPACE_AUTH_REVOKED',
    );

    const active = receipt(
      await state.manager.start({
        workspaceId: 'b',
        taskTitle: 'Approval target',
        prompt: 'Request approval',
      }),
    );
    const server = state.official.latest(String(active.agentRef));
    server.requestApproval();
    const waiting = await eventually(
      () =>
        state.manager.show({
          agentRef: String(active.agentRef),
        }) as Promise<Receipt>,
      (value) => typeof value.pendingApproval === 'object',
    );
    const approval = waiting.pendingApproval as Receipt;
    state.roots.delete('b');
    state.generations.delete('b');
    await assert.rejects(
      state.manager.approve({
        agentRef: String(active.agentRef),
        approvalRequestId: String(approval.approvalRequestId),
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORKSPACE_AUTH_REVOKED',
    );
    await state.manager.reject({
      agentRef: String(active.agentRef),
      approvalRequestId: String(approval.approvalRequestId),
    });
  } finally {
    await state.cleanup();
  }
});

test('revoked Workspace blocks MCP interaction accept while decline remains cleanup-safe', async () => {
  const state = await fixture();
  try {
    const interactive = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Interaction target',
        prompt: 'Request MCP input',
      }),
    );
    const server = state.official.latest(String(interactive.agentRef));
    server.requestFormElicitation();
    const waiting = await eventually(
      () =>
        state.manager.show({
          agentRef: String(interactive.agentRef),
        }) as Promise<Receipt>,
      (value) => typeof value.pendingInteraction === 'object',
    );
    const interaction = waiting.pendingInteraction as Receipt;
    state.roots.delete('a');
    state.generations.delete('a');
    await assert.rejects(
      state.manager.interact({
        agentRef: String(interactive.agentRef),
        interactionRequestId: String(interaction.interactionRequestId),
        action: 'accept',
        content: { choice: 'one' },
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORKSPACE_AUTH_REVOKED',
    );
    const declined = receipt(
      await state.manager.interact({
        agentRef: String(interactive.agentRef),
        interactionRequestId: String(interaction.interactionRequestId),
        action: 'decline',
      }),
    );
    assert.equal(declined.status, 'running');
  } finally {
    await state.cleanup();
  }
});

test('active Workspace revocation interrupts and tears down the owned process', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Revoked active',
        prompt: 'Stay active',
      }),
    );
    const server = state.official.latest(String(started.agentRef));
    server.crashOnInterrupt = true;
    await state.manager.revokeWorkspace('a');
    const revoked = receipt(
      await state.manager.show({ agentRef: String(started.agentRef) }),
    );
    assert.equal(revoked.workspaceAuthorizationStatus, 'revoked');
    assert.equal(revoked.status, 'cancelled');
    assert.equal(revoked.latestError, 'WORKSPACE_AUTH_REVOKED');
    assert.equal(revoked.officialSessionReleased, true);
    assert.equal(revoked.repoWriterReleased, true);
    assert.equal(revoked.taskAppServerState, 'stopped');
    assert.equal(
      (revoked.lifecycleDiagnostics as string[]).some((entry) =>
        entry.startsWith('app_server_crash:'),
      ),
      false,
    );
    assert.ok(server.calls.some((call) => call.method === 'turn/interrupt'));
    assert.ok(server.closes >= 1);
    await assert.rejects(
      state.manager.send({
        agentRef: String(started.agentRef),
        message: 'Forbidden resume after explicit revocation',
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORKSPACE_AUTH_REVOKED',
    );
    const listed = receipt(await state.manager.list({ workspaceId: 'a' }));
    assert.equal((listed.items as Receipt[])[0]?.agentRef, started.agentRef);
    const waited = receipt(
      await state.manager.wait({
        agentRef: String(started.agentRef),
        timeoutMs: 0,
      }),
    );
    assert.equal(waited.workspaceAuthorizationStatus, 'revoked');
  } finally {
    await state.cleanup();
  }
});

test('terminal list/show reconcile external archive and unarchive without loading task runtime', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'History',
        prompt: 'Complete',
      }),
    );
    state.official.latest(String(started.agentRef)).complete();
    const done = await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => value.officialSessionReleased === true,
    );
    const threadId = String(done.threadId);
    state.official.archived.add(threadId);
    const archived = receipt(
      await state.manager.show({ agentRef: String(started.agentRef) }),
    );
    assert.equal(archived.archived, true);
    state.official.archived.delete(threadId);
    const unarchived = receipt(
      await state.manager.show({ agentRef: String(started.agentRef) }),
    );
    assert.equal(unarchived.archived, false);
    assert.equal(unarchived.officialThreadLoadState, 'notLoaded');
    assert.equal(
      state.official.taskServers().filter((server) => server.starts > 0).length,
      1,
    );
  } finally {
    await state.cleanup();
  }
});

test('restart reconciles persisted released work once and terminalizes stale ownership', async () => {
  const state = await fixture();
  let recovered: AgentManager | undefined;
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Persisted running',
        prompt: 'Remain running',
      }),
    );
    await state.manager.close();
    recovered = await AgentManager.create(state.options);
    const shown = receipt(
      await recovered.show({ agentRef: String(started.agentRef) }),
    );
    assert.equal(shown.status, 'failed');
    assert.equal(shown.taskStatus, 'failed');
    assert.equal(shown.turnStatus, 'failed');
    assert.equal(shown.terminal, true);
    assert.equal(shown.lifecycleIntegrity, 'recovery_failed');
    assert.equal(shown.latestError, 'MANAGER_SHUTDOWN_INTERRUPTED');
    assert.equal(shown.officialSessionReleased, true);
    assert.equal(shown.repoWriterReleased, true);
    assert.equal(shown.taskAppServerState, 'stopped');
    assert.equal(shown.recommendedAction, 'archive');
    const listed = receipt(await recovered.list({}));
    assert.equal((listed.items as unknown[]).length, 1);
    const recoveryServers = state.official.servers.filter(
      (server) => server.agentRef === 'metadata',
    );
    assert.ok(recoveryServers.length >= 1);
    assert.equal(
      recoveryServers.some((server) =>
        server.calls.some(
          (call) =>
            call.method === 'thread/resume' || call.method === 'turn/interrupt',
        ),
      ),
      false,
    );
  } finally {
    await recovered?.close();
    await state.manager.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('persisted stale cancel is idempotent and the finalized task can archive', async () => {
  const state = await fixture();
  let recovered: AgentManager | undefined;
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Stale cancel',
        prompt: 'Remain running until restart',
      }),
    );
    await state.manager.close();
    recovered = await AgentManager.create(state.options);

    const firstCancel = receipt(
      await recovered.cancel({ agentRef: String(started.agentRef) }),
    );
    const secondCancel = receipt(
      await recovered.cancel({ agentRef: String(started.agentRef) }),
    );
    assert.equal(firstCancel.terminal, true);
    assert.equal(firstCancel.status, 'failed');
    assert.equal(firstCancel.lifecycleIntegrity, 'recovery_failed');
    assert.equal(secondCancel.nextSeq, firstCancel.nextSeq);
    await assert.rejects(
      recovered.send({
        agentRef: String(started.agentRef),
        message: 'Must not resume released recovery failure',
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_NOT_IDLE',
    );
    assert.equal(
      state.official.servers.some((server) =>
        server.calls.some(
          (call) =>
            call.method === 'thread/resume' || call.method === 'turn/interrupt',
        ),
      ),
      false,
    );

    const archived = receipt(
      await recovered.archive({ agentRef: String(started.agentRef) }),
    );
    assert.equal(archived.archived, true);
    assert.equal(archived.terminal, true);
    assert.equal(archived.officialSessionReleased, true);
    assert.equal(archived.repoWriterReleased, true);
  } finally {
    await recovered?.close();
    await state.manager.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('restart makes persisted MCP interaction non-actionable instead of replayable', async () => {
  const state = await fixture();
  let recovered: AgentManager | undefined;
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Persisted interaction',
        prompt: 'Request input.',
      }),
    );
    state.official.latest(String(started.agentRef)).requestFormElicitation();
    const beforeRestart = await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => typeof value.pendingInteraction === 'object',
    );
    const interactionRequestId = String(
      (beforeRestart.pendingInteraction as Receipt).interactionRequestId,
    );
    recovered = await AgentManager.create(state.options);
    const shown = receipt(
      await recovered.show({ agentRef: String(started.agentRef) }),
    );
    if (shown.pendingInteraction) {
      const recoveredInteraction = shown.pendingInteraction as Receipt;
      assert.equal(recoveredInteraction.actionable, false);
      assert.equal(
        recoveredInteraction.interactionRequestId,
        interactionRequestId,
      );
    }
    await assert.rejects(
      recovered.interact({
        agentRef: String(started.agentRef),
        interactionRequestId,
        action: 'decline',
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_INTERACTION_STALE',
    );
  } finally {
    await recovered?.close();
    await state.cleanup();
  }
});

test('legacy workspace-dev-v1 inventory remains readable after codex-native-v1 upgrade', async () => {
  const state = await fixture();
  let recovered: AgentManager | undefined;
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Legacy profile',
        prompt: 'Complete.',
      }),
    );
    state.official.latest(String(started.agentRef)).complete();
    await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => value.officialSessionReleased === true,
    );
    await state.manager.close();
    const inventoryPath = path.join(
      state.root,
      'state',
      'codex-agent-inventory.json',
    );
    const document = JSON.parse(await readFile(inventoryPath, 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    assert.equal(document.tasks.length, 1);
    document.tasks[0] = {
      ...document.tasks[0],
      capabilityProfile: 'workspace-dev-v1',
    };
    await writeFile(inventoryPath, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
    });
    recovered = await AgentManager.create(state.options);
    const shown = receipt(
      await recovered.show({ agentRef: String(started.agentRef) }),
    );
    assert.equal(shown.capabilityProfile, 'workspace-dev-v1');
  } finally {
    await recovered?.close();
    await state.manager.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test('wait remains single-observation default-8s and hard-max-15s contract', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Wait',
        prompt: 'Wait',
      }),
    );
    await assert.rejects(
      state.manager.wait({
        agentRef: String(started.agentRef),
        timeoutMs: 15_001,
      }),
    );
    const immediate = receipt(
      await state.manager.wait({
        agentRef: String(started.agentRef),
        timeoutMs: 0,
      }),
    );
    assert.equal(immediate.recommendedAction, 'wait_bounded');
    const waiting = state.manager.wait({ agentRef: String(started.agentRef) });
    setTimeout(
      () => state.official.latest(String(started.agentRef)).complete(),
      10,
    );
    const result = receipt(await waiting);
    assert.equal(result.status, 'completed');
  } finally {
    await state.cleanup();
  }
});

test('archive is a governance action allowed only after terminal release', async () => {
  const state = await fixture();
  try {
    const started = receipt(
      await state.manager.start({
        workspaceId: 'a',
        taskTitle: 'Archive',
        prompt: 'Complete',
      }),
    );
    await assert.rejects(
      state.manager.archive({ agentRef: String(started.agentRef) }),
    );
    state.official.latest(String(started.agentRef)).complete();
    await eventually(
      () =>
        state.manager.show({
          agentRef: String(started.agentRef),
        }) as Promise<Receipt>,
      (value) => value.officialSessionReleased === true,
    );
    const archived = receipt(
      await state.manager.archive({ agentRef: String(started.agentRef) }),
    );
    assert.equal(archived.archived, true);
    assert.equal(archived.officialSessionReleased, true);
  } finally {
    await state.cleanup();
  }
});
