import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReleaseReadinessError,
  waitForControlPlaneReadiness,
  waitForLocalStartup,
} from '../src/release-readiness.js';

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

test('local startup waits for MCP and managed services without requiring control-plane readiness', async () => {
  const clock = fakeClock();
  await waitForLocalStartup(
    async () => ({
      mcpReady: clock.now() >= 2_000,
      ...(clock.now() >= 2_000 ? { toolCount: 27 } : {}),
      coreInstalled: true,
      coreRunning: clock.now() >= 500,
      tunnelInstalled: true,
      tunnelRunning: clock.now() >= 1_000,
      recoveryInstalled: true,
    }),
    {
      ...clock,
      expectedToolCount: 27,
      timeoutMs: 20_000,
      intervalMs: 500,
    },
  );
  assert.equal(clock.now(), 2_000);
});

test('control-plane readiness may arrive after the old 20s gate but before the 60s bound', async () => {
  const clock = fakeClock();
  await waitForControlPlaneReadiness(
    async () => ({
      coreMcpReady: true,
      tunnelRunning: true,
      pollReady: clock.now() >= 25_000,
    }),
    { ...clock, timeoutMs: 60_000, intervalMs: 1_000 },
  );
  assert.equal(clock.now(), 25_000);
});

test('control-plane readiness succeeds close to but before the 60s bound', async () => {
  const clock = fakeClock();
  await waitForControlPlaneReadiness(
    async () => ({
      coreMcpReady: true,
      tunnelRunning: true,
      pollReady: clock.now() >= 55_000,
    }),
    { ...clock, timeoutMs: 60_000, intervalMs: 1_000 },
  );
  assert.equal(clock.now(), 55_000);
});

test('control-plane readiness times out deterministically when no successful poll appears', async () => {
  const clock = fakeClock();
  await assert.rejects(
    waitForControlPlaneReadiness(
      async () => ({
        coreMcpReady: true,
        tunnelRunning: true,
        pollReady: false,
      }),
      { ...clock, timeoutMs: 60_000, intervalMs: 1_000 },
    ),
    (error) =>
      error instanceof ReleaseReadinessError &&
      error.code === 'CONTROL_PLANE_POLL_TIMEOUT',
  );
  assert.equal(clock.now(), 60_000);
});

test('control-plane readiness fails early if Tunnel stops', async () => {
  const clock = fakeClock();
  await assert.rejects(
    waitForControlPlaneReadiness(
      async () => ({
        coreMcpReady: true,
        tunnelRunning: clock.now() < 4_000,
        pollReady: false,
      }),
      { ...clock, timeoutMs: 60_000, intervalMs: 1_000 },
    ),
    (error) =>
      error instanceof ReleaseReadinessError &&
      error.code === 'TUNNEL_PROCESS_STOPPED',
  );
  assert.equal(clock.now(), 4_000);
});

test('control-plane readiness fails early if Core MCP regresses', async () => {
  const clock = fakeClock();
  await assert.rejects(
    waitForControlPlaneReadiness(
      async () => ({
        coreMcpReady: clock.now() < 3_000,
        tunnelRunning: true,
        pollReady: false,
      }),
      { ...clock, timeoutMs: 60_000, intervalMs: 1_000 },
    ),
    (error) =>
      error instanceof ReleaseReadinessError &&
      error.code === 'LOCAL_MCP_FAILED',
  );
  assert.equal(clock.now(), 3_000);
});

test('a rollback readiness observation can succeed after 20s without becoming a safe-stop', async () => {
  const clock = fakeClock();
  await waitForControlPlaneReadiness(
    async () => ({
      coreMcpReady: true,
      tunnelRunning: true,
      pollReady: clock.now() >= 30_000,
    }),
    { ...clock, timeoutMs: 60_000, intervalMs: 1_000 },
  );
  assert.equal(clock.now(), 30_000);
});
