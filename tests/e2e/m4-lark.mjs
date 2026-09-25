import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createLocalinkRuntime } from '../../packages/runtime/dist/src/index.js';
import { PublicAdapter } from '../../packages/mcp-server/dist/src/index.js';

const endpoint = 'http://127.0.0.1:33332/mcp';
const stateRoot = await mkdtemp(path.join(tmpdir(), 'localink-m4-lark-'));

function data(result) {
  assert.equal(result.isError, false);
  assert.ok(result.structuredContent);
  return result.structuredContent.data;
}

async function runAttempt() {
  const runtime = await createLocalinkRuntime({ stateRoot });
  try {
    const adapter = new PublicAdapter(runtime);
    const search = data(
      await adapter.call('localink.capability_search', {
        query: 'lark_capability_list',
        limit: 20,
      }),
    );
    const capability = search.items.find((item) =>
      `${item.title} ${item.description}`.includes('lark_capability_list'),
    );
    assert.ok(capability);
    const description = data(
      await adapter.call('localink.capability_describe', {
        capabilityId: capability.id,
      }),
    );
    assert.equal(description.operationClass, 'read');
    assert.equal(description.riskTier, 0);
    assert.equal(description.postVerify, 'none');
    const invoked = await adapter.call('localink.capability_invoke', {
      capabilityId: capability.id,
      input: {},
    });
    assert.equal(invoked.isError, false);
    assert.equal(invoked.structuredContent.data.status, 'executed');
    assert.ok(Buffer.byteLength(JSON.stringify(invoked)) <= 16 * 1024);
    const health = data(await adapter.call('localink.health_status', {}));
    assert.equal(health.sharedAssets.externalMcp.readyProviders, 1);
    assert.equal(JSON.stringify(health).includes(endpoint), false);
    const provider = health.sharedAssets.externalMcp.providers.find(
      (item) => item.id === 'lark',
    );
    assert.ok(provider);
    return {
      ok: true,
      capabilityId: capability.id,
      operationClass: description.operationClass,
      riskTier: description.riskTier,
      eligibleReadTools: provider.eligibleReadTools,
      eligibleProjectedTools: provider.eligibleProjectedTools,
      projectedToolsByTier: provider.projectedToolsByTier,
      skippedTools: provider.skippedTools,
      boundedBytes: Buffer.byteLength(JSON.stringify(invoked)),
    };
  } finally {
    await runtime.close();
  }
}

async function narrowHealthProbe() {
  return new Promise((resolve) => {
    const request = get('http://127.0.0.1:33332/health', (response) => {
      response.resume();
      resolve({ reachable: true, status: response.statusCode });
    });
    request.setTimeout(3_000, () => request.destroy());
    request.once('error', () => resolve({ reachable: false }));
  });
}

try {
  const setup = await createLocalinkRuntime({ stateRoot });
  await setup.addHttpProvider('lark', endpoint);
  await setup.close();

  let firstFailed = false;
  let probe;
  let result;
  try {
    result = await runAttempt();
  } catch {
    firstFailed = true;
    probe = await narrowHealthProbe();
    result = await runAttempt();
  }
  process.stdout.write(
    `${JSON.stringify({ ...result, firstFailed, ...(probe ? { probe } : {}) }, null, 2)}\n`,
  );
} catch {
  process.stderr.write(
    `${JSON.stringify({ ok: false, code: 'LARK_PROVIDER_E2E_FAILED', message: 'Risk-aware Lark bridge failed after the allowed retry budget.' })}\n`,
  );
  process.exitCode = 1;
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}
