import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureRuntime } from '../src/fixture-runtime.js';
import { PublicAdapter } from '../src/public-adapter.js';
import type { AgentController } from '../src/runtime.js';
import {
  PUBLIC_AGENT_LIMITS,
  TOOL_NAMES,
  toolAnnotations,
  toolSchemas,
} from '../src/tool-definitions.js';
import { at, envelope } from './helpers.js';

const AGENT_TOOLS = [
  'localink.agent_start',
  'localink.agent_list',
  'localink.agent_show',
  'localink.agent_wait',
  'localink.agent_send',
  'localink.agent_approve',
  'localink.agent_reject',
  'localink.agent_interact',
  'localink.agent_cancel',
  'localink.agent_archive',
] as const;

test('Agent public surface is exact 41 with bounded strict schemas and conservative hints', () => {
  assert.equal(TOOL_NAMES.length, 41);
  assert.equal(new Set(TOOL_NAMES).size, 41);
  assert.deepEqual(
    TOOL_NAMES.filter((name) => name.startsWith('localink.agent_')),
    AGENT_TOOLS,
  );
  for (const name of AGENT_TOOLS) {
    assert.equal(
      toolAnnotations[name].readOnlyHint,
      [
        'localink.agent_list',
        'localink.agent_show',
        'localink.agent_wait',
      ].includes(name),
    );
  }
  assert.deepEqual(toolAnnotations['localink.agent_start'], {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: true,
  });
  assert.deepEqual(toolAnnotations['localink.agent_wait'], {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  });
  const validStart = {
    workspaceId: 'workspace',
    taskTitle: 'Small task',
    prompt: 'Write a fixture note.',
  };
  assert.equal(
    toolSchemas['localink.agent_start'].safeParse(validStart).success,
    true,
  );
  assert.equal(
    toolSchemas['localink.agent_start'].safeParse({
      ...validStart,
      threadId: 'other',
    }).success,
    false,
  );
  assert.equal(
    toolSchemas['localink.agent_start'].safeParse({
      ...validStart,
      supervisionMode: 'thirty_seconds',
    }).success,
    false,
  );
  assert.equal(
    toolSchemas['localink.agent_start'].safeParse({
      ...validStart,
      prompt: 'x'.repeat(PUBLIC_AGENT_LIMITS.promptCharacters + 1),
    }).success,
    false,
  );
  assert.equal(
    toolSchemas['localink.agent_wait'].safeParse({
      agentRef: 'agent-1',
      timeoutMs: 15_000,
    }).success,
    true,
  );
  assert.equal(
    toolSchemas['localink.agent_wait'].safeParse({
      agentRef: 'agent-1',
      timeoutMs: 15_001,
    }).success,
    false,
  );
  assert.equal(
    toolSchemas['localink.agent_send'].safeParse({
      agentRef: 'agent-1',
      message: '',
    }).success,
    false,
  );
  assert.equal(
    toolSchemas['localink.agent_approve'].safeParse({
      agentRef: 'agent-1',
      approvalRequestId: 'opaque',
      rawJsonRpcId: 1,
    }).success,
    false,
  );
  const cases: Array<[(typeof AGENT_TOOLS)[number], Record<string, unknown>]> =
    [
      ['localink.agent_start', validStart],
      ['localink.agent_list', { status: 'awaiting_approval', limit: 20 }],
      ['localink.agent_show', { agentRef: 'agent-1' }],
      ['localink.agent_wait', { agentRef: 'agent-1', afterSeq: 0 }],
      ['localink.agent_send', { agentRef: 'agent-1', message: 'Continue.' }],
      [
        'localink.agent_approve',
        { agentRef: 'agent-1', approvalRequestId: 'opaque' },
      ],
      [
        'localink.agent_reject',
        { agentRef: 'agent-1', approvalRequestId: 'opaque' },
      ],
      [
        'localink.agent_interact',
        {
          agentRef: 'agent-1',
          interactionRequestId: 'interaction-1',
          action: 'decline',
        },
      ],
      ['localink.agent_cancel', { agentRef: 'agent-1' }],
      ['localink.agent_archive', { agentRef: 'agent-1' }],
    ];
  for (const [name, input] of cases) {
    assert.equal(toolSchemas[name].safeParse(input).success, true, name);
    assert.equal(
      toolSchemas[name].safeParse({ ...input, rawThreadId: 'unowned' }).success,
      false,
      name,
    );
  }
  assert.equal(
    toolSchemas['localink.agent_list'].safeParse({ status: 'archived' })
      .success,
    false,
  );
  assert.equal(
    toolSchemas['localink.agent_wait'].safeParse({
      agentRef: 'agent-1',
      afterSeq: -1,
    }).success,
    false,
  );
});

test('Agent adapter dispatches all ten tools, defaults supervision and bounds each wait', async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const record = (method: string, input: unknown) => {
    calls.push({ method, input });
    return Promise.resolve({ method, input });
  };
  const agents: AgentController = {
    start: (input) => record('start', input),
    list: (input) => record('list', input),
    show: (input) => record('show', input),
    wait: (input) => record('wait', input),
    send: (input) => record('send', input),
    approve: (input) => record('approve', input),
    reject: (input) => record('reject', input),
    interact: (input) => record('interact', input),
    cancel: (input) => record('cancel', input),
    archive: (input) => record('archive', input),
  };
  const fixture = await createFixtureRuntime();
  let refreshes = 0;
  const adapter = new PublicAdapter({
    ...fixture,
    agents,
    async refreshAgents() {
      refreshes++;
    },
  });
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      'agent_start',
      { workspaceId: 'workspace', taskTitle: 'Small task', prompt: 'Do it.' },
    ],
    ['agent_list', {}],
    ['agent_show', { agentRef: 'agent-1' }],
    ['agent_wait', { agentRef: 'agent-1', afterSeq: 2 }],
    ['agent_send', { agentRef: 'agent-1', message: 'Continue.' }],
    ['agent_approve', { agentRef: 'agent-1', approvalRequestId: 'approval-1' }],
    ['agent_reject', { agentRef: 'agent-1', approvalRequestId: 'approval-2' }],
    [
      'agent_interact',
      {
        agentRef: 'agent-1',
        interactionRequestId: 'interaction-1',
        action: 'decline',
      },
    ],
    ['agent_cancel', { agentRef: 'agent-1' }],
    ['agent_archive', { agentRef: 'agent-1' }],
  ];
  for (const [name, input] of cases) {
    const receipt = envelope(await adapter.call(`localink.${name}`, input));
    assert.equal(at(receipt, 'data', 'method'), name.slice('agent_'.length));
  }
  assert.equal(refreshes, AGENT_TOOLS.length);
  assert.equal(calls.length, AGENT_TOOLS.length);
  assert.deepEqual(calls[0]?.input, {
    workspaceId: 'workspace',
    taskTitle: 'Small task',
    prompt: 'Do it.',
    supervisionMode: 'auto',
  });
  assert.deepEqual(calls[1]?.input, { limit: 20 });
  assert.deepEqual(calls[3]?.input, {
    agentRef: 'agent-1',
    afterSeq: 2,
    timeoutMs: 8_000,
  });
  const tooLong = envelope(
    await adapter.call('localink.agent_wait', {
      agentRef: 'agent-1',
      timeoutMs: 15_001,
    }),
  );
  assert.equal(at(tooLong, 'data', 'error', 'code'), 'INVALID_ARGUMENT');
  assert.equal(calls.length, AGENT_TOOLS.length);
});

test('Agent optional runtime fails visibly; writer conflict exposes only safe identity fields', async () => {
  const fixture = await createFixtureRuntime();
  const unavailable = envelope(
    await new PublicAdapter(fixture).call('localink.agent_list', {}),
  );
  assert.equal(
    at(unavailable, 'data', 'error', 'code'),
    'CAPABILITY_UNAVAILABLE',
  );

  const secret = 'synthetic-secret-must-not-leak';
  const conflict = Object.assign(new Error(secret), {
    code: 'AGENT_WRITER_CONFLICT',
    details: {
      existingAgentRef: 'agent-1',
      title: 'Existing task',
      status: 'running',
      rawThreadId: secret,
    },
  });
  const agents: AgentController = {
    start: () => Promise.reject(conflict),
    list: () => Promise.resolve({}),
    show: () => Promise.resolve({}),
    wait: () => Promise.resolve({}),
    send: () => Promise.resolve({}),
    approve: () => Promise.resolve({}),
    reject: () => Promise.resolve({}),
    interact: () => Promise.resolve({}),
    cancel: () => Promise.resolve({}),
    archive: () => Promise.resolve({}),
  };
  const result = envelope(
    await new PublicAdapter({ ...fixture, agents }).call(
      'localink.agent_start',
      {
        workspaceId: 'workspace',
        taskTitle: 'Second task',
        prompt: 'Do it.',
      },
    ),
  );
  assert.equal(at(result, 'data', 'error', 'code'), 'AGENT_WRITER_CONFLICT');
  assert.equal(at(result, 'data', 'error', 'existingAgentRef'), 'agent-1');
  assert.equal(at(result, 'data', 'error', 'title'), 'Existing task');
  assert.equal(at(result, 'data', 'error', 'status'), 'running');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Agent adapter preserves the public Workspace revocation error', async () => {
  const fixture = await createFixtureRuntime();
  const revoked = Object.assign(new Error('private resolver detail'), {
    code: 'WORKSPACE_AUTH_REVOKED',
  });
  const agents: AgentController = {
    start: () => Promise.reject(revoked),
    list: () => Promise.resolve({}),
    show: () => Promise.resolve({}),
    wait: () => Promise.resolve({}),
    send: () => Promise.reject(revoked),
    approve: () => Promise.reject(revoked),
    reject: () => Promise.resolve({}),
    interact: () => Promise.reject(revoked),
    cancel: () => Promise.resolve({}),
    archive: () => Promise.resolve({}),
  };
  const adapter = new PublicAdapter({ ...fixture, agents });
  for (const [name, input] of [
    [
      'localink.agent_start',
      { workspaceId: 'removed', taskTitle: 'Revoked', prompt: 'Do it.' },
    ],
    [
      'localink.agent_send',
      { agentRef: 'agent-1', message: 'Forbidden resume' },
    ],
    [
      'localink.agent_approve',
      { agentRef: 'agent-1', approvalRequestId: 'approval-1' },
    ],
    [
      'localink.agent_interact',
      {
        agentRef: 'agent-1',
        interactionRequestId: 'interaction-1',
        action: 'accept',
        content: {},
      },
    ],
  ] as const) {
    const result = envelope(await adapter.call(name, input));
    assert.equal(at(result, 'data', 'error', 'code'), 'WORKSPACE_AUTH_REVOKED');
    assert.equal(
      JSON.stringify(result).includes('private resolver detail'),
      false,
    );
  }
});
