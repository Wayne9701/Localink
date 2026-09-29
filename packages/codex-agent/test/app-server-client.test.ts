import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AppServerRpcError,
  ManagedAppServerClient,
} from '../src/app-server-client.js';

const fakeServer = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.env.LOCALINK_FAKE_APP_SERVER_LOG;
function record(value) { if (log) fs.appendFileSync(log, JSON.stringify(value) + '\\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
record({kind:'spawn', args:process.argv.slice(2), pid:process.pid});
let initialized = false;
let waitingId;
let ignoreTerm = false;
process.on('SIGTERM', () => { if (!ignoreTerm) process.exit(0); });
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  record({kind:'message', message});
  if (message.method === 'initialize') {
    send({jsonrpc:'2.0', id:message.id, result:{userAgent:'fake'}});
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'ping') {
    send({jsonrpc:'2.0', method:'thread/status/changed', params:{threadId:'owned', status:{type:'idle'}}});
    send({jsonrpc:'2.0', id:99, method:'mcpServer/elicitation/request', params:{threadId:'owned', turnId:null, serverName:'fixture', mode:'url', _meta:null, message:'fixture', url:'https://example.com', elicitationId:'fixture'}});
    waitingId = message.id;
  } else if (message.id === 99) {
    send({jsonrpc:'2.0', id:waitingId, result:{initialized, reply:message.result, error:message.error, pid:process.pid}});
    waitingId = undefined;
  } else if (message.method === 'die') {
    process.exit(9);
  } else if (message.method === 'rpc-error') {
    send({jsonrpc:'2.0', id:message.id, error:{code:-32602, message:'fixture invalid params'}});
  } else if (message.method === 'large-valid') {
    send({jsonrpc:'2.0', id:message.id, result:{payload:'x'.repeat(2 * 1024 * 1024)}});
  } else if (message.method === 'oversize') {
    ignoreTerm = true;
    setInterval(() => {}, 1000);
    process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
  }
});
`;

async function fixture(): Promise<{
  directory: string;
  executable: string;
  log: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'localink-codex-client-'));
  const executable = join(directory, 'fake-codex');
  const log = join(directory, 'events.jsonl');
  await writeFile(executable, fakeServer, { mode: 0o755 });
  return { directory, executable, log };
}

test('managed client initializes once, routes server messages, and closes its child', async () => {
  const { directory, executable, log } = await fixture();
  const notifications: string[] = [];
  const requests: string[] = [];
  const crashes: string[] = [];
  let client: ManagedAppServerClient | undefined;
  try {
    client = new ManagedAppServerClient({
      executable,
      environment: { ...process.env, LOCALINK_FAKE_APP_SERVER_LOG: log },
      onNotification: (method) => notifications.push(method),
      onRequest: (id, method) => {
        requests.push(method);
        if (requests.length === 1) {
          client?.respond(id, {
            action: 'decline',
            content: null,
            _meta: null,
          });
        } else {
          client?.respondError(id, -32601, 'Unsupported elicitation');
        }
      },
      onCrash: (reason) => crashes.push(reason),
    });
    await Promise.all([client.start(), client.start()]);
    const first = (await client.request('ping', {})) as {
      initialized: boolean;
      reply: { action: string };
      pid: number;
    };
    const second = (await client.request('ping', {})) as {
      initialized: boolean;
      error: { code: number; message: string };
    };
    assert.equal(first.initialized, true);
    assert.equal(second.initialized, true);
    assert.deepEqual(second.error, {
      code: -32601,
      message: 'Unsupported elicitation',
    });
    assert.equal(first.reply.action, 'decline');
    assert.deepEqual(notifications, [
      'thread/status/changed',
      'thread/status/changed',
    ]);
    assert.deepEqual(requests, [
      'mcpServer/elicitation/request',
      'mcpServer/elicitation/request',
    ]);
    await client.close();
    assert.deepEqual(crashes, []);
    const messages = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(messages.filter((event) => event.kind === 'spawn').length, 1);
    assert.deepEqual(messages[0]?.args, ['app-server', '--stdio']);
    const initialize = messages.find(
      (event) =>
        event.kind === 'message' &&
        (event.message as Record<string, unknown>).method === 'initialize',
    );
    assert.deepEqual(
      (
        (initialize?.message as Record<string, unknown>).params as Record<
          string,
          unknown
        >
      ).capabilities,
      { experimentalApi: true, requestAttestation: false },
    );
    const alive = spawnSync('/bin/kill', ['-0', String(first.pid)]);
    assert.notEqual(alive.status, 0);
  } finally {
    await client?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a child crash rejects pending RPC and reports loss of the managed process', async () => {
  const { directory, executable, log } = await fixture();
  const crashes: string[] = [];
  const client = new ManagedAppServerClient({
    executable,
    environment: { ...process.env, LOCALINK_FAKE_APP_SERVER_LOG: log },
    onCrash: (reason) => crashes.push(reason),
  });
  try {
    await client.start();
    await assert.rejects(client.request('die', {}), /App Server unavailable/);
    assert.equal(crashes.length, 1);
    assert.match(crashes[0] ?? '', /exit code=9/);
    await assert.rejects(client.request('ping', {}), /not ready/);
    await client.start();
    await assert.rejects(client.request('rpc-error', {}), AppServerRpcError);
    const events = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events.filter((event) => event.kind === 'spawn').length, 2);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('RPC errors preserve official error code and malformed output cannot orphan a child', async () => {
  const { directory, executable, log } = await fixture();
  const crashes: string[] = [];
  const client = new ManagedAppServerClient({
    executable,
    environment: { ...process.env, LOCALINK_FAKE_APP_SERVER_LOG: log },
    onCrash: (reason) => crashes.push(reason),
  });
  try {
    await client.start();
    await assert.rejects(client.request('rpc-error', {}), (error: unknown) => {
      assert.ok(error instanceof AppServerRpcError);
      assert.equal(error.code, -32602);
      return true;
    });
    await assert.rejects(
      client.request('oversize', {}),
      /stdout line limit exceeded/,
    );
    assert.equal(crashes.length, 1);
    assert.match(crashes[0] ?? '', /stdout line limit exceeded/);
    await client.close();
    const events = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const pid = events.find((event) => event.kind === 'spawn')?.pid;
    assert.equal(typeof pid, 'number');
    const alive = spawnSync('/bin/kill', ['-0', String(pid)]);
    assert.notEqual(alive.status, 0);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a valid two-megabyte JSON-RPC line is dispatched without crashing', async () => {
  const { directory, executable } = await fixture();
  const crashes: string[] = [];
  const client = new ManagedAppServerClient({
    executable,
    onCrash: (reason) => crashes.push(reason),
  });
  try {
    await client.start();
    const result = (await client.request('large-valid', {})) as {
      payload: string;
    };
    assert.equal(Buffer.byteLength(result.payload), 2 * 1024 * 1024);
    assert.deepEqual(crashes, []);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
