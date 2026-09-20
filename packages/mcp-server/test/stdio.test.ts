import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { RESULT_LIMITS } from '../src/bounded-result.js';
import { SECRET_LIKE_FIXTURE } from '../src/fixture-runtime.js';
import { TOOL_NAMES } from '../src/tool-definitions.js';
import {
  at,
  call,
  envelope,
  fixtureStdioClient,
  invoke,
  stdioClient,
  stdioEntry,
} from './helpers.js';

test(
  'stdio: official client initialize, exact 21 tools, all policy/registry/error/bounding paths, clean exit',
  { timeout: 20_000 },
  async (t) => {
    const connection = await fixtureStdioClient();
    const { client, transport } = connection;
    t.after(() => client.close());
    const pid = transport.pid;
    assert.ok(pid);
    assert.equal(client.getServerVersion()?.name, 'localink');
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      TOOL_NAMES,
    );
    assert.equal(
      at(await call(client, 'health_status'), 'data', 'module', 'status'),
      'healthy',
    );
    const search = await call(client, 'capability_search', {
      query: 'fixture',
      limit: 2,
    });
    assert.equal((at(search, 'data', 'items') as unknown[]).length, 2);
    assert.equal(at(search, 'data', 'hasMore'), true);
    const description = await call(client, 'capability_describe', {
      capabilityId: 'fixture.write',
    });
    assert.equal(at(description, 'data', 'postVerify'), 'required');
    assert.ok(!JSON.stringify(description).includes('handler'));
    assert.equal(
      at(await invoke(client, 'fixture.read'), 'data', 'status'),
      'executed',
    );
    const write = await invoke(client, 'fixture.write', { value: 'updated' });
    assert.equal(at(write, 'data', 'status'), 'executed');
    assert.equal(at(write, 'data', 'verification', 'verified'), true);
    assert.equal(
      at(await invoke(client, 'fixture.read'), 'data', 'output', 'value'),
      'updated',
    );
    assert.equal(
      at(await invoke(client, 'fixture.external-send'), 'data', 'status'),
      'confirmation_required',
    );
    assert.equal(
      at(
        await invoke(
          client,
          'fixture.protected',
          {},
          { policyProfile: 'open' },
        ),
        'data',
        'status',
      ),
      'denied',
    );
    const health = await call(client, 'health_status');
    assert.equal(at(health, 'data', 'state', 'externalSendExecutions'), 0);
    assert.equal(at(health, 'data', 'state', 'protectedExecutions'), 0);
    assert.equal(
      at(
        await invoke(
          client,
          'fixture.write',
          { value: 'blocked' },
          { policyProfile: 'strict' },
        ),
        'data',
        'status',
      ),
      'confirmation_required',
    );
    assert.equal(
      at(await invoke(client, 'fixture.read'), 'data', 'output', 'value'),
      'updated',
    );
    const skills = await call(client, 'skill_search', { query: 'fixture' });
    assert.equal((at(skills, 'data', 'items') as unknown[]).length, 1);
    const skill = await call(client, 'skill_read', {
      skillId: 'fixture.skill',
      maxBytes: 16,
    });
    assert.equal(at(skill, 'data', 'trust'), 'untrusted-asset');
    assert.equal(at(skill, 'data', 'truncated'), true);

    const identity = { id: 'alice', type: 'fixture-user' };
    for (const [id, context, expected] of [
      ['fixture.missing', undefined, 'CAPABILITY_NOT_FOUND'],
      ['fixture.identity', undefined, 'IDENTITY_REQUIRED'],
      ['fixture.identity', { identity }, 'SCOPE_REQUIRED'],
      ['fixture.unverified', undefined, 'VERIFICATION_REQUIRED'],
      ['fixture.failure', undefined, 'CAPABILITY_UNAVAILABLE'],
    ] as const) {
      const result = await invoke(client, id, {}, context);
      assert.equal(at(result, 'data', 'error', 'code'), expected);
      assert.ok(!JSON.stringify(result).includes(SECRET_LIKE_FIXTURE));
    }
    assert.equal(
      at(
        await invoke(client, 'fixture.failure'),
        'data',
        'error',
        'reasonCode',
      ),
      'CAPABILITY_HANDLER_FAILED',
    );
    assert.equal(
      at(
        await invoke(
          client,
          'fixture.identity',
          {},
          { identity, grantedScopes: ['fixture:read'] },
        ),
        'data',
        'output',
        'identityId',
      ),
      'alice',
    );
    for (const [name, args] of [
      ['capability_search', { limit: 0 }],
      ['capability_search', { query: 'x'.repeat(300) }],
      ['health_status', { injected: 'not accepted' }],
      [
        'capability_invoke',
        { capabilityId: 'fixture.write', input: { value: 17 } },
      ],
      [
        'capability_invoke',
        {
          capabilityId: 'fixture.read',
          input: {},
          fixtureContext: {
            workspacePolicyOverride: { decisions: { 3: 'allow' } },
          },
        },
      ],
    ] as const) {
      const result = await client.callTool({
        name: `localink.${name}`,
        arguments: args,
      });
      assert.equal(result.isError, true);
      assert.equal(
        at(envelope(result), 'data', 'error', 'code'),
        'INVALID_ARGUMENT',
      );
    }
    const unknown = await client.callTool({
      name: 'localink.missing',
      arguments: {},
    });
    assert.equal(unknown.isError, true);
    assert.equal(
      at(envelope(unknown), 'data', 'error', 'code'),
      'UNKNOWN_TOOL',
    );
    const large = await client.callTool({
      name: 'localink.capability_invoke',
      arguments: { capabilityId: 'fixture.read', input: { rows: 4096 } },
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(large)) <= RESULT_LIMITS.defaultBytes,
    );
    const largeEnvelope = envelope(large);
    assert.equal(at(largeEnvelope, 'truncation', 'truncated'), true);
    assert.equal(at(largeEnvelope, 'data', 'status'), 'executed');
    const rows = at(largeEnvelope, 'data', 'output', 'rows') as {
      index: number;
    }[];
    assert.ok(rows.length > 0 && rows.length < 4096);
    assert.equal(rows[0]?.index, 0);
    assert.deepEqual(connection.errors, []); // SDK parser saw protocol-only stdout.
    assert.equal(connection.stderr, '');
    await client.close();
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);

test(
  'stdio: v2 modern negotiation works with the same public surface',
  { timeout: 15_000 },
  async (t) => {
    const { client } = await fixtureStdioClient(true);
    t.after(() => client.close());
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      TOOL_NAMES,
    );
    assert.equal(
      at(await call(client, 'health_status'), 'data', 'mode'),
      'fixture',
    );
  },
);

test(
  'stdio product entrypoint exposes exact 21 tools with real runtime health',
  { timeout: 15_000 },
  async (t) => {
    const connection = await stdioClient(true);
    const { client } = connection;
    t.after(async () => {
      await client.close();
      await connection.cleanup();
    });
    assert.equal(client.getServerVersion()?.name, 'localink');
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      TOOL_NAMES,
    );
    const invokeTool = listed.tools.find(
      (tool) => tool.name === 'localink.capability_invoke',
    );
    assert.equal(JSON.stringify(invokeTool).includes('fixtureContext'), false);
    const health = await call(client, 'health_status');
    assert.equal(at(health, 'data', 'mode'), 'runtime');
    assert.equal(at(health, 'data', 'workspaceCount'), 0);
    assert.equal(at(health, 'data', 'capabilityCount'), 0);
    assert.equal(at(health, 'data', 'skillCount'), 0);
    assert.equal(at(health, 'data', 'state', 'ready'), true);
    assert.equal(at(health, 'data', 'state', 'schemaVersion'), 1);
    assert.equal(JSON.stringify(health).includes(connection.stateRoot), false);
  },
);

test(
  'stdio: bare EOF exits with code zero and no output or signal',
  { timeout: 5000 },
  async (t) => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'localink-eof-'));
    t.after(() => rm(stateRoot, { recursive: true, force: true }));
    const child = spawn(process.execPath, [stdioEntry], {
      stdio: 'pipe',
      env: { ...process.env, LOCALINK_STATE_ROOT: stateRoot },
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = once(child, 'close');
    child.stdin.end();
    assert.deepEqual(await closed, [0, null]);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  },
);

test(
  'stdio: initialized child exits on EOF without SDK kill escalation; raw stdout is protocol only',
  { timeout: 5000 },
  async (t) => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'localink-eof-'));
    t.after(() => rm(stateRoot, { recursive: true, force: true }));
    const child = spawn(process.execPath, [stdioEntry], {
      stdio: 'pipe',
      env: { ...process.env, LOCALINK_STATE_ROOT: stateRoot },
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Use the official SDK's stream transport over an owned child so exit status
    // is observable; no custom JSON-RPC encoding or process-kill close fallback.
    const transport = new StdioServerTransport(child.stdout, child.stdin);
    const client = new Client({ name: 'eof-proof', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(transport);
    await call(client, 'health_status');
    const closed = once(child, 'close');
    child.stdin.end();
    assert.deepEqual(await closed, [0, null]);
    assert.equal(stderr, '');
    const lines = stdout.trim().split('\n');
    assert.ok(lines.length >= 2);
    for (const line of lines)
      assert.equal(at(JSON.parse(line), 'jsonrpc'), '2.0');
  },
);
