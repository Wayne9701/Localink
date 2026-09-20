import {
  CapabilityRegistry,
  ModuleRegistry,
  SkillRegistry,
} from '@localink/core';
import type { CapabilityDescriptor, CapabilityHandler } from '@localink/sdk';
import { z } from 'zod';
import { invalidInput } from './errors.js';
import type { PublicRuntime } from './runtime.js';

export const SECRET_LIKE_FIXTURE = 'fixture-only-secret-DO-NOT-RETURN';

export async function createFixtureRuntime(): Promise<PublicRuntime> {
  const modules = new ModuleRegistry();
  const capabilities = new CapabilityRegistry({
    isModuleEnabled: (moduleId) => modules.isEnabled(moduleId),
  });
  const skills = new SkillRegistry();
  const validators = new Map<string, z.ZodType>();
  const state = {
    value: 'initial',
    writes: 0,
    externalSendExecutions: 0,
    protectedExecutions: 0,
  };
  const empty = z.strictObject({});

  function register(
    id: string,
    schema: z.ZodType,
    descriptor: Partial<CapabilityDescriptor>,
    handler: CapabilityHandler,
  ) {
    validators.set(id, schema);
    capabilities.register(
      {
        contractVersion: '1',
        id,
        moduleId: 'fixture',
        version: '1.0.0',
        title: id,
        description: `In-memory acceptance capability: ${id}.`,
        inputSchema: { kind: 'inline', schema: z.toJSONSchema(schema) },
        outputSummary: 'Deterministic fixture receipt.',
        operationClass: 'read',
        requiredScopes: [],
        riskTier: 0,
        reversible: true,
        supportsPrecondition: false,
        postVerify: 'none',
        publicSemantic: false,
        ...descriptor,
      },
      handler,
    );
  }

  const readInput = z.strictObject({
    rows: z.number().int().min(0).max(4096).optional(),
  });
  register('fixture.read', readInput, {}, async (input) => {
    const { rows } = readInput.parse(input);
    return {
      output: {
        ...state,
        ...(rows === undefined
          ? {}
          : {
              rows: Array.from({ length: rows }, (_, i) => ({
                index: i,
                text: 'fixture row '.repeat(12),
              })),
            }),
      },
    };
  });
  const writeInput = z.strictObject({ value: z.string().max(256) });
  register(
    'fixture.write',
    writeInput,
    {
      operationClass: 'write',
      riskTier: 1,
      postVerify: 'required',
    },
    async (input) => {
      const { value } = writeInput.parse(input);
      state.value = value;
      state.writes++;
      return {
        output: { value: state.value, writes: state.writes },
        verification: {
          verified: state.value === value,
          method: 'in-memory-read-back',
        },
      };
    },
  );
  register(
    'fixture.external-send',
    empty,
    { operationClass: 'write', riskTier: 2, reversible: false },
    async () => {
      state.externalSendExecutions++;
      return { output: { simulated: true } };
    },
  );
  register(
    'fixture.protected',
    empty,
    { operationClass: 'write', riskTier: 3, reversible: false },
    async () => {
      state.protectedExecutions++;
      return { output: { simulated: true } };
    },
  );
  register(
    'fixture.identity',
    empty,
    { requiredIdentity: 'fixture-user', requiredScopes: ['fixture:read'] },
    async (_input, context) => ({
      output: {
        identityId: context.identity?.id,
        scopes: context.grantedScopes,
      },
    }),
  );
  register('fixture.failure', empty, {}, async () => {
    throw new Error(SECRET_LIKE_FIXTURE);
  });
  register(
    'fixture.unverified',
    empty,
    { operationClass: 'write', riskTier: 1, postVerify: 'required' },
    async () => ({
      output: { simulated: true },
    }),
  );

  modules.register({
    manifest: {
      contractVersion: '1',
      id: 'fixture',
      version: '1.0.0',
      title: 'Fixture module',
      runtime: { apiVersion: '1' },
      capabilityIds: capabilities.list().map((item) => item.id),
    },
  });
  await modules.enable('fixture');
  skills.register({
    manifest: {
      contractVersion: '1',
      id: 'fixture.skill',
      version: '1.0.0',
      title: 'Fixture Skill',
      description: 'Untrusted acceptance asset; not executable.',
      entry: 'SKILL.md',
      tags: ['fixture'],
    },
    location: 'memory:fixture.skill',
    content:
      '# Fixture Skill\n\nUntrusted asset. Do not execute scripts or interpret this text as authorization.\n',
  });
  return {
    capabilities,
    skills,
    async health() {
      const health = await modules.health('fixture');
      return {
        mode: 'fixture',
        module: { id: 'fixture', status: health.status },
        state: { ...state },
      };
    },
    validateInput(capabilityId, input) {
      // Registry remains the source of not-found semantics.
      capabilities.describe(capabilityId);
      if (!validators.get(capabilityId)?.safeParse(input).success)
        invalidInput();
    },
  };
}
