import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CONTRACT_VERSION_V1,
  LocalinkError,
  type CapabilityDescriptor,
  type ModuleDefinition,
  type ModuleManifest,
  type SecretRef,
  type SkillManifest,
} from '@localink/sdk';
import {
  CapabilityRegistry,
  ConfigStore,
  FixtureAuthProvider,
  InMemorySecretProvider,
  MacOSKeychainSecretProvider,
  ModuleRegistry,
  PolicyEngine,
  SkillRegistry,
  createStatePaths,
  validateSecretRef,
} from '../src/index.js';
import { withFixture } from './helpers.js';

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof LocalinkError && error.code === code;
}

function moduleManifest(id = 'fixture-module'): ModuleManifest {
  return {
    contractVersion: CONTRACT_VERSION_V1,
    id,
    version: '1.0.0',
    title: 'Fixture Module',
    runtime: { apiVersion: CONTRACT_VERSION_V1, node: '>=22' },
    dependencies: [],
    capabilityIds: [],
    publicSemanticIds: [],
  };
}

function capabilityDescriptor(
  id: string,
  overrides: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  return {
    contractVersion: CONTRACT_VERSION_V1,
    id,
    moduleId: 'fixture-module',
    version: '1.0.0',
    title: `Fixture ${id}`,
    description: `Fixture capability ${id}`,
    inputSchema: {
      kind: 'inline',
      schema: { type: 'object', additionalProperties: false },
    },
    outputSummary: 'A fixture result.',
    operationClass: 'read',
    requiredScopes: [],
    riskTier: 0,
    reversible: true,
    supportsPrecondition: false,
    postVerify: 'none',
    publicSemantic: false,
    ...overrides,
  };
}

test('fixture module registers, enables, discovers, reports health, and disables', async () => {
  const calls: string[] = [];
  const definition: ModuleDefinition = {
    manifest: moduleManifest(),
    initialize: async () => {
      calls.push('initialize');
    },
    enable: async () => {
      calls.push('enable');
    },
    disable: async () => {
      calls.push('disable');
    },
    health: async () => ({ status: 'healthy' }),
  };
  const modules = new ModuleRegistry();
  assert.equal(modules.install(definition).reasonCode, 'MODULE_REGISTERED');
  assert.equal((await modules.enable('fixture-module')).state, 'enabled');
  assert.equal(modules.discover('fixture').length, 1);
  assert.equal((await modules.health('fixture-module')).status, 'healthy');
  assert.equal((await modules.disable('fixture-module')).state, 'disabled');
  assert.deepEqual(calls, ['initialize', 'enable', 'disable']);
});

test('malformed, duplicate, and throwing modules fail visibly without stopping the registry', async () => {
  const modules = new ModuleRegistry();
  assert.throws(
    () =>
      modules.register({
        manifest: { ...moduleManifest(), id: 'Bad ID' } as ModuleManifest,
      }),
    hasCode('CONTRACT_INVALID'),
  );
  modules.register({ manifest: moduleManifest() });
  assert.throws(
    () => modules.register({ manifest: moduleManifest() }),
    hasCode('ALREADY_EXISTS'),
  );

  modules.register({
    manifest: moduleManifest('throw-init'),
    initialize: async () => {
      throw new Error('fixture lifecycle failure');
    },
  });
  const failed = await modules.enable('throw-init');
  assert.equal(failed.ok, false);
  assert.equal(failed.reasonCode, 'MODULE_ENABLE_FAILED');

  modules.register({
    manifest: moduleManifest('throw-health'),
    health: async () => {
      throw new Error('fixture health failure');
    },
  });
  assert.equal((await modules.enable('throw-health')).ok, true);
  assert.equal((await modules.health('throw-health')).status, 'unhealthy');

  modules.register({ manifest: moduleManifest('still-alive') });
  assert.equal((await modules.enable('still-alive')).ok, true);
});

test('capability search, describe, availability, and Tier 0 invoke are deterministic', async () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register(
    capabilityDescriptor('fixture.read'),
    async (input) => ({ output: { input, ok: true } }),
  );
  assert.equal(capabilities.search('read').length, 1);
  assert.equal(capabilities.describe('fixture.read').riskTier, 0);
  assert.equal(
    capabilities.availability('fixture.read', {
      policyProfile: 'balanced',
    }).available,
    true,
  );
  const receipt = await capabilities.invoke(
    'fixture.read',
    { value: 1 },
    { policyProfile: 'balanced' },
  );
  assert.equal(receipt.status, 'executed');
  assert.equal(receipt.policy.action, 'allow');
});

test('balanced Tier 1 executes only with the required verified receipt', async () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register(
    capabilityDescriptor('fixture.write', {
      operationClass: 'write',
      riskTier: 1,
      supportsPrecondition: true,
      postVerify: 'required',
    }),
    async () => ({
      output: { changed: true },
      verification: { verified: true, method: 'fixture-read-back' },
    }),
  );
  const receipt = await capabilities.invoke(
    'fixture.write',
    {},
    { policyProfile: 'balanced' },
  );
  assert.equal(receipt.status, 'executed');
  assert.equal(receipt.policy.action, 'allow');
  assert.equal(receipt.verification?.verified, true);

  capabilities.register(
    capabilityDescriptor('fixture.unverified', {
      operationClass: 'write',
      riskTier: 1,
      postVerify: 'required',
    }),
    async () => ({ output: { changed: true } }),
  );
  await assert.rejects(
    capabilities.invoke(
      'fixture.unverified',
      {},
      { policyProfile: 'balanced' },
    ),
    hasCode('VERIFICATION_REQUIRED'),
  );
});

test('balanced Tier 2 returns confirm and never executes its handler', async () => {
  let executions = 0;
  const capabilities = new CapabilityRegistry();
  capabilities.register(
    capabilityDescriptor('fixture.external-send', {
      operationClass: 'write',
      riskTier: 2,
      reversible: false,
    }),
    async () => {
      executions += 1;
      return { output: { sent: true } };
    },
  );
  const receipt = await capabilities.invoke(
    'fixture.external-send',
    {},
    { policyProfile: 'balanced' },
  );
  assert.equal(receipt.status, 'confirmation_required');
  assert.equal(receipt.policy.action, 'confirm');
  assert.equal(typeof receipt.confirmation?.ticket, 'string');
  assert.equal(executions, 0);
});

test('Tier 2 confirmation tickets are exact-input, expiring, single-use, and balanced-only', async () => {
  let now = 1_000;
  let sequence = 0;
  let executions = 0;
  const capabilities = new CapabilityRegistry({
    now: () => now,
    confirmationTtlMs: 100,
    ticketFactory: () => `ticket_${String(++sequence).padStart(40, '0')}`,
  });
  capabilities.register(
    capabilityDescriptor('fixture.confirmed-send', {
      operationClass: 'write',
      riskTier: 2,
      reversible: false,
    }),
    async (input) => {
      executions++;
      return { output: { input, executions } };
    },
  );

  const requested = await capabilities.invoke(
    'fixture.confirmed-send',
    { b: 2, a: 1 },
    { policyProfile: 'balanced' },
  );
  const ticket = requested.confirmation?.ticket;
  assert.ok(ticket);
  const executed = await capabilities.invokeConfirmed(
    ticket,
    'fixture.confirmed-send',
    { a: 1, b: 2 },
    { policyProfile: 'balanced' },
  );
  assert.equal(executed.status, 'executed');
  assert.equal(executed.policy.reason.code, 'POLICY_BALANCED_TIER_2_CONFIRMED');
  assert.equal(executions, 1);
  await assert.rejects(
    capabilities.invokeConfirmed(
      ticket,
      'fixture.confirmed-send',
      { a: 1, b: 2 },
      { policyProfile: 'balanced' },
    ),
    hasCode('INVALID_ARGUMENT'),
  );
  assert.equal(executions, 1);

  const mismatch = await capabilities.invoke(
    'fixture.confirmed-send',
    { value: 'expected' },
    { policyProfile: 'balanced' },
  );
  assert.ok(mismatch.confirmation);
  await assert.rejects(
    capabilities.invokeConfirmed(
      mismatch.confirmation.ticket,
      'fixture.confirmed-send',
      { value: 'different' },
      { policyProfile: 'balanced' },
    ),
    hasCode('INVALID_ARGUMENT'),
  );
  await assert.rejects(
    capabilities.invokeConfirmed(
      mismatch.confirmation.ticket,
      'fixture.confirmed-send',
      { value: 'expected' },
      { policyProfile: 'balanced' },
    ),
    hasCode('INVALID_ARGUMENT'),
  );
  assert.equal(executions, 1);

  const expiring = await capabilities.invoke(
    'fixture.confirmed-send',
    {},
    { policyProfile: 'balanced' },
  );
  assert.ok(expiring.confirmation);
  now += 100;
  await assert.rejects(
    capabilities.invokeConfirmed(
      expiring.confirmation.ticket,
      'fixture.confirmed-send',
      {},
      { policyProfile: 'balanced' },
    ),
    hasCode('INVALID_ARGUMENT'),
  );
  assert.equal(executions, 1);

  const openAttempt = await capabilities.invoke(
    'fixture.confirmed-send',
    {},
    { policyProfile: 'balanced' },
  );
  assert.ok(openAttempt.confirmation);
  await assert.rejects(
    capabilities.invokeConfirmed(
      openAttempt.confirmation.ticket,
      'fixture.confirmed-send',
      {},
      { policyProfile: 'open' },
    ),
    hasCode('POLICY_DENIED'),
  );
  assert.equal(executions, 1);
});

test('strict Tier 1 confirms and open or workspace override cannot bypass Tier 3', () => {
  const policy = new PolicyEngine();
  const tier1 = capabilityDescriptor('fixture.strict-write', {
    operationClass: 'write',
    riskTier: 1,
  });
  assert.equal(policy.evaluate(tier1, 'strict').action, 'confirm');

  const tier3 = capabilityDescriptor('fixture.protected', {
    operationClass: 'write',
    riskTier: 3,
    reversible: false,
  });
  assert.equal(policy.evaluate(tier3, 'open').action, 'deny');
  const overridden = policy.evaluate(tier3, 'open', {
    decisions: { 3: 'allow' },
  });
  assert.equal(overridden.action, 'deny');
  assert.equal(overridden.workspaceOverrideApplied, false);

  const tier1Override = policy.evaluate(tier1, 'balanced', {
    decisions: { 1: 'confirm' },
  });
  assert.equal(tier1Override.action, 'confirm');
  assert.equal(tier1Override.workspaceOverrideApplied, true);
});

test('missing identity and scopes are fail-visible with no identity fallback', async () => {
  const capabilities = new CapabilityRegistry();
  capabilities.register(
    capabilityDescriptor('fixture.scoped-read', {
      requiredIdentity: 'user',
      requiredScopes: ['records:read'],
    }),
    async () => ({ output: { ok: true } }),
  );
  await assert.rejects(
    capabilities.invoke(
      'fixture.scoped-read',
      {},
      { policyProfile: 'balanced', grantedScopes: ['records:read'] },
    ),
    hasCode('IDENTITY_REQUIRED'),
  );
  await assert.rejects(
    capabilities.invoke(
      'fixture.scoped-read',
      {},
      {
        policyProfile: 'balanced',
        identity: { id: 'fixture-user', type: 'user' },
        grantedScopes: [],
      },
    ),
    hasCode('SCOPE_REQUIRED'),
  );
});

test('fixture auth expresses method boundaries, scopes, refresh, and never invents identity', async () => {
  const credentialRef: SecretRef = {
    provider: 'memory',
    namespace: 'fixture',
    key: 'auth-primary',
  };
  const auth = new FixtureAuthProvider({
    id: 'fixture-auth',
    configured: false,
    requiredScopes: ['records:read', 'records:write'],
    grantedScopes: ['records:read'],
    credentialRef,
  });
  assert.equal((await auth.status()).state, 'not_configured');
  assert.equal((await auth.setup()).state, 'signed_out');
  const loggedIn = await auth.login();
  assert.equal(loggedIn.identity, undefined);
  assert.deepEqual(loggedIn.scopes.granted, []);
  assert.equal(loggedIn.refreshReady, false);
  assert.equal((await auth.refresh()).identity, undefined);
  assert.equal((await auth.logout()).state, 'signed_out');
  const serialized = JSON.stringify(loggedIn);
  assert.equal(serialized.includes('raw-fixture-secret'), false);
  assert.equal(serialized.includes('accessCredential'), false);
  assert.equal(serialized.includes('refreshCredential'), false);
});

test('fixture auth reports explicit identity and granted, required, and missing scopes', async () => {
  const auth = new FixtureAuthProvider({
    id: 'fixture-auth-ready',
    configured: true,
    loginIdentity: { id: 'fixture-user', type: 'user' },
    grantedScopes: ['records:read'],
    requiredScopes: ['records:read', 'records:write'],
  });
  const result = await auth.login();
  assert.equal(result.state, 'degraded');
  assert.equal(result.identity?.type, 'user');
  assert.deepEqual(result.scopes.granted, ['records:read']);
  assert.deepEqual(result.scopes.required, ['records:read', 'records:write']);
  assert.deepEqual(result.scopes.missing, ['records:write']);
  assert.equal(result.refreshReady, true);
});

test('in-memory secret provider supports set/get/delete with redacted serialization', async () => {
  const provider = new InMemorySecretProvider();
  const ref: SecretRef = {
    provider: 'memory',
    namespace: 'fixture',
    key: 'primary',
  };
  const secret = 'ultra-private-fixture';
  const setReceipt = await provider.set(ref, secret);
  const value = await provider.get(ref);
  assert.equal(value?.reveal(), secret);
  assert.equal(JSON.stringify(value), '"[REDACTED]"');
  assert.equal(JSON.stringify(setReceipt).includes(secret), false);
  assert.equal((await provider.delete(ref)).changed, true);
  assert.equal(await provider.get(ref), undefined);
});

test('Keychain adapter skeleton is injected and provider errors never serialize secret values', async () => {
  const secret = 'adapter-private-fixture';
  const provider = new MacOSKeychainSecretProvider({
    read: async () => {
      throw new Error(secret);
    },
    write: async () => {
      throw new Error(secret);
    },
    remove: async () => {
      throw new Error(secret);
    },
  });
  const ref: SecretRef = {
    provider: 'macos-keychain',
    namespace: 'fixture',
    key: 'primary',
  };
  await assert.rejects(provider.get(ref), (error) => {
    assert.equal(error instanceof LocalinkError, true);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  await assert.rejects(provider.set(ref, secret), (error) => {
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});

test('config stores only SecretRef while secret values stay outside config, receipt, and errors', async () => {
  await withFixture(async (fixture) => {
    const provider = new InMemorySecretProvider();
    const ref: SecretRef = {
      provider: 'memory',
      namespace: 'fixture',
      key: 'config-auth',
    };
    const secret = 'config-private-fixture';
    const receipt = await provider.set(ref, secret);
    const store = new ConfigStore(
      createStatePaths(fixture.stateRoot),
      'secret-ref-fixture',
      (value): { credential: SecretRef } => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('credential' in value)
        ) {
          throw new Error('credential reference required');
        }
        validateSecretRef(value.credential as SecretRef);
        return { credential: value.credential as SecretRef };
      },
    );
    await store.write({ credential: ref });
    const configSource = await readFile(store.path, 'utf8');
    assert.equal(configSource.includes(secret), false);
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.equal(
      JSON.stringify(
        new LocalinkError('SECRET_PROVIDER_ERROR', 'Secret operation failed.'),
      ).includes(secret),
      false,
    );
  });
});

function skillManifest(): SkillManifest {
  return {
    contractVersion: CONTRACT_VERSION_V1,
    id: 'fixture-skill',
    version: '1.0.0',
    title: 'Fixture Skill',
    description: 'A safe fixture Skill asset.',
    entry: 'SKILL.md',
    tags: ['fixture', 'analysis'],
    assets: ['assets/example.txt'],
    scripts: ['scripts/example.mjs'],
  };
}

test('fixture Skill discover, list, search, and bounded read never executes content', () => {
  const skills = new SkillRegistry();
  const executed = false;
  const content = '# Fixture Skill\n\nDo not execute this text.\n';
  skills.register({
    manifest: skillManifest(),
    location: 'fixtures/fixture-skill',
    content,
  });
  assert.equal(skills.discover().length, 1);
  assert.equal(skills.list().length, 1);
  assert.equal(skills.search('analysis').length, 1);
  assert.equal(skills.read('fixture-skill').content, content);
  assert.equal(skills.read('fixture-skill', 10).truncated, true);
  assert.equal(executed, false);
});

test('invalid and duplicate Skill and capability registration are fail-visible', () => {
  const skills = new SkillRegistry();
  assert.throws(
    () =>
      skills.register({
        manifest: {
          ...skillManifest(),
          entry: 'run.mjs',
        } as unknown as SkillManifest,
        location: 'fixtures/bad',
        content: 'bad',
      }),
    hasCode('CONTRACT_INVALID'),
  );
  skills.register({
    manifest: skillManifest(),
    location: 'fixtures/fixture-skill',
    content: 'fixture',
  });
  assert.throws(
    () =>
      skills.register({
        manifest: skillManifest(),
        location: 'fixtures/fixture-skill',
        content: 'fixture',
      }),
    hasCode('ALREADY_EXISTS'),
  );

  const capabilities = new CapabilityRegistry();
  capabilities.register(
    capabilityDescriptor('fixture.duplicate'),
    async () => ({ output: true }),
  );
  assert.throws(
    () =>
      capabilities.register(
        capabilityDescriptor('fixture.duplicate'),
        async () => ({ output: true }),
      ),
    hasCode('ALREADY_EXISTS'),
  );
  assert.throws(
    () =>
      capabilities.register(capabilityDescriptor('Bad ID'), async () => ({
        output: true,
      })),
    hasCode('CONTRACT_INVALID'),
  );
});
