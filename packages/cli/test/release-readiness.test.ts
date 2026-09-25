import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReleaseReadinessError,
  activateCoreFirst,
  waitForControlPlaneReadiness,
  waitForCoreStartup,
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

test('a stale persisted status cannot satisfy the live local-startup gate', async () => {
  const clock = fakeClock();
  // This represents a formerly-ready service-status.json. The release gate
  // receives only fresh launchd/MCP observations from its live probe.
  const stalePersistedStatus = {
    localMcpReadiness: 'ready',
    checkedAt: '2020-01-01T00:00:00.000Z',
  } as const;
  assert.equal(stalePersistedStatus.localMcpReadiness, 'ready');
  await assert.rejects(
    waitForLocalStartup(
      async () => ({
        mcpReady: false,
        coreInstalled: true,
        coreRunning: true,
        tunnelInstalled: true,
        tunnelRunning: true,
        recoveryInstalled: true,
      }),
      {
        ...clock,
        expectedToolCount: 27,
        timeoutMs: 1_000,
        intervalMs: 250,
      },
    ),
    (error) =>
      error instanceof ReleaseReadinessError &&
      error.code === 'LOCAL_MCP_FAILED',
  );
  assert.equal(clock.now(), 1_000);
});

test('core gate waits for exact live MCP readiness before Tunnel can start', async () => {
  const clock = fakeClock();
  const events: string[] = [];
  await activateCoreFirst({
    rebootstrapCore: async () => {
      events.push('core-rebootstrap');
    },
    waitForCore: async () => {
      await waitForCoreStartup(
        async () => ({
          mcpReady: clock.now() >= 1_000,
          ...(clock.now() >= 1_000 ? { toolCount: 27 } : {}),
          coreInstalled: true,
          coreRunning: true,
          recoveryInstalled: true,
        }),
        {
          ...clock,
          expectedToolCount: 27,
          timeoutMs: 2_000,
          intervalMs: 250,
        },
      );
      events.push('core-ready');
    },
    bootstrapTunnel: async () => {
      events.push('tunnel-bootstrap');
    },
    waitForLocalServices: async () => {
      events.push('local-services-ready');
    },
    waitForControlPlane: async () => {
      events.push('control-plane-ready');
    },
  });
  assert.deepEqual(events, [
    'core-rebootstrap',
    'core-ready',
    'tunnel-bootstrap',
    'local-services-ready',
    'control-plane-ready',
  ]);
  assert.equal(clock.now(), 1_000);
});

test('core readiness timeout fails closed without starting Tunnel', async () => {
  const clock = fakeClock();
  let tunnelStarted = false;
  await assert.rejects(
    activateCoreFirst({
      rebootstrapCore: async () => undefined,
      waitForCore: async () =>
        waitForCoreStartup(
          async () => ({
            mcpReady: false,
            coreInstalled: true,
            coreRunning: true,
            recoveryInstalled: true,
          }),
          {
            ...clock,
            expectedToolCount: 27,
            timeoutMs: 1_000,
            intervalMs: 250,
          },
        ),
      bootstrapTunnel: async () => {
        tunnelStarted = true;
      },
      waitForLocalServices: async () => undefined,
      waitForControlPlane: async () => undefined,
    }),
    (error) =>
      error instanceof ReleaseReadinessError &&
      error.code === 'LOCAL_MCP_FAILED',
  );
  assert.equal(tunnelStarted, false);
  assert.equal(clock.now(), 1_000);
});

test('core-first activation requires a fresh control-plane poll after Tunnel bootstrap', async () => {
  const clock = fakeClock();
  const events: string[] = [];
  await activateCoreFirst({
    rebootstrapCore: async () => {
      events.push('core-rebootstrap');
    },
    waitForCore: async () => {
      events.push('core-ready');
    },
    bootstrapTunnel: async () => {
      events.push('tunnel-bootstrap');
    },
    waitForLocalServices: async () => {
      events.push('local-services-ready');
    },
    waitForControlPlane: async () => {
      await waitForControlPlaneReadiness(
        async () => ({
          coreMcpReady: true,
          tunnelRunning: true,
          // A ready value from before this Tunnel boot is deliberately not
          // accepted; only the live probe after bootstrap changes this.
          pollReady: clock.now() >= 1_000,
        }),
        { ...clock, timeoutMs: 2_000, intervalMs: 250 },
      );
      events.push('control-plane-ready');
    },
  });
  assert.deepEqual(events, [
    'core-rebootstrap',
    'core-ready',
    'tunnel-bootstrap',
    'local-services-ready',
    'control-plane-ready',
  ]);
  assert.equal(clock.now(), 1_000);
});

test('stale Tunnel startup readiness cannot satisfy the control-plane gate', async () => {
  const clock = fakeClock();
  const staleTunnelStatus = {
    healthz: 200,
    readyz: 200,
    controlPlanePollOk: false,
  } as const;
  await assert.rejects(
    waitForControlPlaneReadiness(
      async () => ({
        coreMcpReady: true,
        tunnelRunning: true,
        // healthz/readyz alone can remain stale after a startup race. The
        // release path supplies this only from `health --require-control-plane-poll`.
        pollReady: staleTunnelStatus.controlPlanePollOk,
      }),
      { ...clock, timeoutMs: 1_000, intervalMs: 250 },
    ),
    (error) =>
      error instanceof ReleaseReadinessError &&
      error.code === 'CONTROL_PLANE_POLL_TIMEOUT',
  );
  assert.equal(staleTunnelStatus.readyz, 200);
  assert.equal(clock.now(), 1_000);
});

test('prior-service restoration can use the same core-first safe sequence', async () => {
  const events: string[] = [];
  const restore = async (name: string) =>
    activateCoreFirst({
      rebootstrapCore: async () => {
        events.push(`${name}:core-rebootstrap`);
      },
      waitForCore: async () => {
        events.push(`${name}:core-ready`);
      },
      bootstrapTunnel: async () => {
        events.push(`${name}:tunnel-bootstrap`);
      },
      waitForLocalServices: async () => {
        events.push(`${name}:local-ready`);
      },
      waitForControlPlane: async () => {
        events.push(`${name}:poll-ready`);
      },
    });
  await restore('activation');
  await restore('prior');
  assert.deepEqual(events, [
    'activation:core-rebootstrap',
    'activation:core-ready',
    'activation:tunnel-bootstrap',
    'activation:local-ready',
    'activation:poll-ready',
    'prior:core-rebootstrap',
    'prior:core-ready',
    'prior:tunnel-bootstrap',
    'prior:local-ready',
    'prior:poll-ready',
  ]);
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
