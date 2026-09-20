import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { request } from 'node:http';
import test from 'node:test';
import { createFixtureRuntime } from '../src/fixture-runtime.js';
import { startHttpServer, httpOptionsFromEnv } from '../src/http.js';
import { PROTOCOL_VERSION } from '../src/server.js';
import { at, call, httpClient, invoke, stdioClient } from './helpers.js';

test(
  'HTTP: modern per-request adapters, shared app state, isolated context, failures/abort/close and released port',
  { timeout: 20_000 },
  async (t) => {
    const runtime = await createFixtureRuntime();
    let blockNext = false;
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listening = await startHttpServer({
      port: 0,
      runtime: {
        ...runtime,
        async health() {
          if (blockNext) {
            blockNext = false;
            entered?.();
            await blocked;
          }
          return runtime.health();
        },
      },
    });
    t.after(async () => {
      release?.();
      await listening.close();
    });
    assert.equal(listening.address.address, '127.0.0.1');
    const a = await httpClient(listening.url);
    t.after(() => a.client.close());
    const b = await httpClient(listening.url);
    t.after(() => b.client.close());
    const stdio = await stdioClient();
    t.after(() => stdio.client.close());
    assert.equal(a.client.getServerVersion()?.name, 'localink-fixture');
    assert.equal(a.transport.protocolVersion, PROTOCOL_VERSION);
    const oversized = await a.client.callTool({
      name: 'localink.capability_invoke',
      arguments: { capabilityId: 'fixture.read', input: { rows: 4096 } },
    });
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 16 * 1024);
    assert.equal(
      at(oversized.structuredContent, 'truncation', 'truncated'),
      true,
    );
    const [aTools, bTools, stdioTools] = await Promise.all([
      a.client.listTools(),
      b.client.listTools(),
      stdio.client.listTools(),
    ]);
    assert.deepEqual(aTools.tools, stdioTools.tools);
    assert.deepEqual(aTools.tools, bTools.tools);
    assert.deepEqual(
      await call(a.client, 'health_status'),
      await call(stdio.client, 'health_status'),
    );
    const before = listening.adaptersCreated;
    await call(a.client, 'health_status');
    await call(b.client, 'health_status');
    assert.equal(listening.adaptersCreated, before + 2);
    assert.equal(
      at(
        await invoke(a.client, 'fixture.write', {
          value: 'shared application value',
        }),
        'data',
        'verification',
        'verified',
      ),
      true,
    );
    assert.equal(
      at(await invoke(b.client, 'fixture.read'), 'data', 'output', 'value'),
      'shared application value',
    );
    assert.equal(
      at(
        await invoke(
          a.client,
          'fixture.identity',
          {},
          {
            identity: { id: 'alice', type: 'fixture-user' },
            grantedScopes: ['fixture:read'],
          },
        ),
        'data',
        'output',
        'identityId',
      ),
      'alice',
    );
    assert.equal(
      at(await invoke(b.client, 'fixture.identity'), 'data', 'error', 'code'),
      'IDENTITY_REQUIRED',
    );
    assert.equal(
      at(
        await invoke(
          b.client,
          'fixture.identity',
          {},
          { identity: { id: 'bob', type: 'fixture-user' } },
        ),
        'data',
        'error',
        'code',
      ),
      'SCOPE_REQUIRED',
    );
    assert.equal(
      at(await invoke(a.client, 'fixture.identity'), 'data', 'error', 'code'),
      'IDENTITY_REQUIRED',
    );
    assert.equal(
      at(
        await invoke(
          a.client,
          'fixture.write',
          { value: 'strict' },
          { policyProfile: 'strict' },
        ),
        'data',
        'status',
      ),
      'confirmation_required',
    );
    assert.equal(
      at(
        await invoke(b.client, 'fixture.write', { value: 'balanced' }),
        'data',
        'status',
      ),
      'executed',
    );
    assert.equal(
      at(
        await invoke(a.client, 'fixture.read', { rows: 1 }),
        'data',
        'output',
        'rows',
      ) instanceof Array,
      true,
    );
    assert.equal(
      at(await invoke(b.client, 'fixture.read'), 'data', 'output', 'rows'),
      undefined,
    );
    assert.equal(
      at(await invoke(a.client, 'fixture.external-send'), 'data', 'status'),
      'confirmation_required',
    );
    assert.equal(
      at(await invoke(b.client, 'fixture.protected'), 'data', 'status'),
      'denied',
    );
    assert.equal(
      at(await invoke(a.client, 'fixture.failure'), 'data', 'error', 'code'),
      'CAPABILITY_UNAVAILABLE',
    );
    assert.equal(
      at(
        await call(b.client, 'health_status'),
        'data',
        'state',
        'externalSendExecutions',
      ),
      0,
    );
    assert.equal(
      at(
        await call(b.client, 'health_status'),
        'data',
        'state',
        'protectedExecutions',
      ),
      0,
    );
    blockNext = true;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const controller = new AbortController();
    const abortCall = a.client.callTool(
      { name: 'localink.health_status', arguments: {} },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(abortCall);
    await enteredPromise;
    controller.abort();
    await rejected;
    assert.equal(
      at(await call(b.client, 'health_status'), 'data', 'module', 'status'),
      'healthy',
    );
    release?.();
    await a.client.close();
    assert.equal(
      at(await invoke(b.client, 'fixture.read'), 'data', 'output', 'value'),
      'balanced',
    );
    for (const connection of [a, b]) {
      assert.equal(connection.headers.sentSession, false);
      assert.equal(connection.headers.receivedSession, false);
      assert.ok(connection.headers.versions.includes(PROTOCOL_VERSION));
    }
    await listening.close();
    await assert.rejects(fetch(listening.url));
    const rebound = createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(listening.address.port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) =>
      rebound.close((error) => (error ? reject(error) : resolve())),
    );
  },
);

test(
  'HTTP: invalid config, host/origin rejection, malformed transport request, legacy rejection',
  { timeout: 10_000 },
  async (t) => {
    for (const env of [
      { LOCALINK_MCP_HOST: '0.0.0.0' },
      { LOCALINK_MCP_PORT: '-1' },
      { LOCALINK_MCP_PORT: '65536' },
    ]) {
      assert.throws(() => httpOptionsFromEnv(env), RangeError);
    }
    assert.deepEqual(httpOptionsFromEnv({}), { host: '127.0.0.1', port: 4318 });
    const server = await startHttpServer({ port: 0 });
    t.after(() => server.close());
    for (const headers of [
      { host: 'example.invalid' },
      { origin: 'https://example.invalid' },
    ]) {
      // fetch may replace Host with the URL authority; use Node's HTTP client
      // to put the exact hostile header on the wire for this transport test.
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = request(server.url, { headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject);
          req.end();
        },
      );
      assert.equal(status, 403);
    }
    const malformed = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
      },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes('stack'));
    const legacy = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-rejection-probe', version: '1.0.0' },
        },
      }),
    });
    assert.ok(legacy.status >= 400);
    assert.equal(legacy.headers.has('mcp-session-id'), false);
    const { client } = await httpClient(server.url);
    t.after(() => client.close());
    assert.equal(
      at(await call(client, 'health_status'), 'data', 'mode'),
      'fixture',
    );
  },
);
