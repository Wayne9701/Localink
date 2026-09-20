import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalinkError } from '@localink/sdk';
import { SecretValue } from '@localink/core';
import { boundedResult, RESULT_LIMITS } from '../src/bounded-result.js';
import {
  createFixtureRuntime,
  SECRET_LIKE_FIXTURE,
} from '../src/fixture-runtime.js';
import { PublicAdapter } from '../src/public-adapter.js';
import { at, envelope } from './helpers.js';

test('bounding: override limits, valid JSON, unicode, array prefixes, truthful byte metadata', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    index,
    text: '😀汉字'.repeat(100),
  }));
  for (const limit of [1024, 2048, 4096, RESULT_LIMITS.defaultBytes]) {
    const result = boundedResult({ rows }, false, limit);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= limit - 256);
    const parsed = envelope(result);
    assert.equal(at(parsed, 'truncation', 'truncated'), true);
    assert.equal(
      at(parsed, 'truncation', 'originalBytes'),
      Buffer.byteLength(JSON.stringify({ rows })),
    );
    assert.equal(
      at(parsed, 'truncation', 'returnedBytes'),
      Buffer.byteLength(JSON.stringify(parsed.data)),
    );
    if (parsed.data !== null) {
      const retained = at(parsed, 'data', 'rows') as { index: number }[];
      assert.ok(retained.length > 0 && retained.length < rows.length);
      assert.equal(retained[0]?.index, 0);
    }
  }
  assert.equal(
    at(envelope(boundedResult({ ok: true })), 'truncation', 'truncated'),
    false,
  );
  for (const limit of [0, 1023, 65537, NaN])
    assert.throws(() => boundedResult({}, false, limit), RangeError);
});

test('errors: secret-like messages/details, cyclic output, SecretValue and invalid input fail closed', async () => {
  const runtime = await createFixtureRuntime();
  for (const thrown of [
    new Error(SECRET_LIKE_FIXTURE),
    new LocalinkError('SCOPE_REQUIRED', SECRET_LIKE_FIXTURE, {
      value: SECRET_LIKE_FIXTURE.repeat(10_000),
    }),
  ]) {
    const adapter = new PublicAdapter(
      {
        ...runtime,
        health: async () => {
          throw thrown;
        },
      },
      1024,
    );
    const result = await adapter.call('localink.health_status', {});
    assert.equal(result.isError, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
    assert.ok(!JSON.stringify(result).includes(SECRET_LIKE_FIXTURE));
  }
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const adapter = new PublicAdapter({ ...runtime, health: async () => cycle });
  assert.equal(
    at(
      envelope(await adapter.call('localink.health_status', {})),
      'data',
      'error',
      'code',
    ),
    'INTERNAL_ERROR',
  );
  assert.ok(
    !JSON.stringify(
      boundedResult({ value: new SecretValue(SECRET_LIKE_FIXTURE) }),
    ).includes(SECRET_LIKE_FIXTURE),
  );
  const ordinary = new PublicAdapter(runtime);
  assert.equal(
    at(
      envelope(
        await ordinary.call('localink.capability_search', {
          query: 'x'.repeat(40_000),
        }),
      ),
      'data',
      'error',
      'code',
    ),
    'SIZE_LIMIT_EXCEEDED',
  );
  const ownPrototype = await ordinary.call('__proto__', {});
  assert.equal(
    at(envelope(ownPrototype), 'data', 'error', 'code'),
    'UNKNOWN_TOOL',
  );
});

test('capability metadata projects V1 fields instead of leaking runtime extensions', async () => {
  const runtime = await createFixtureRuntime();
  const descriptor = {
    ...runtime.capabilities.describe('fixture.read'),
    id: 'fixture.metadata_valid',
    internalHandler: SECRET_LIKE_FIXTURE,
  };
  runtime.capabilities.register(descriptor, async () => ({ output: null }));
  const adapter = new PublicAdapter(runtime);
  for (const result of [
    await adapter.call('localink.capability_search', {
      query: 'fixture.metadata_valid',
    }),
    await adapter.call('localink.capability_describe', {
      capabilityId: 'fixture.metadata_valid',
    }),
  ]) {
    assert.equal(result.isError, false);
    assert.ok(!JSON.stringify(result).includes(SECRET_LIKE_FIXTURE));
  }
});
