import type {
  CapabilityDescriptor,
  CapabilityInvokeContext,
} from '@localink/sdk';
import { LocalinkError } from '@localink/sdk';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  boundedResult,
  assertResultLimit,
  RESULT_LIMITS,
} from './bounded-result.js';
import { invalidInput, publicError } from './errors.js';
import type { PublicRuntime } from './runtime.js';
import {
  INPUT_LIMIT_BYTES,
  toolSchemas,
  type ToolName,
} from './tool-definitions.js';

function capabilityMetadata(item: CapabilityDescriptor): CapabilityDescriptor {
  // Explicit V1 projection: runtime-only extensions must never become public.
  return {
    contractVersion: item.contractVersion,
    id: item.id,
    moduleId: item.moduleId,
    version: item.version,
    title: item.title,
    description: item.description,
    inputSchema: {
      kind: item.inputSchema.kind,
      ...(item.inputSchema.schema === undefined
        ? {}
        : { schema: item.inputSchema.schema }),
      ...(item.inputSchema.reference === undefined
        ? {}
        : { reference: item.inputSchema.reference }),
    },
    outputSummary: item.outputSummary,
    operationClass: item.operationClass,
    ...(item.requiredIdentity === undefined
      ? {}
      : { requiredIdentity: item.requiredIdentity }),
    requiredScopes: item.requiredScopes,
    riskTier: item.riskTier,
    reversible: item.reversible,
    supportsPrecondition: item.supportsPrecondition,
    postVerify: item.postVerify,
    publicSemantic: item.publicSemantic,
  };
}

export class PublicAdapter {
  constructor(
    readonly runtime: PublicRuntime,
    readonly resultLimit: number = RESULT_LIMITS.defaultBytes,
  ) {
    assertResultLimit(resultLimit);
  }

  async call(name: string, args: unknown): Promise<CallToolResult> {
    if (!Object.hasOwn(toolSchemas, name)) {
      return boundedResult(
        {
          error: {
            layer: 'mcp',
            code: 'UNKNOWN_TOOL',
            message: 'Unknown MCP tool.',
          },
        },
        true,
        this.resultLimit,
      );
    }
    try {
      if (Buffer.byteLength(JSON.stringify(args) ?? '') > INPUT_LIMIT_BYTES) {
        throw new LocalinkError('SIZE_LIMIT_EXCEEDED', 'Input too large.');
      }
      const result = await this.dispatch(name as ToolName, args ?? {});
      return boundedResult(result, false, this.resultLimit);
    } catch (error) {
      return boundedResult(
        { error: publicError(error) },
        true,
        this.resultLimit,
      );
    }
  }

  private async dispatch(name: ToolName, args: unknown): Promise<unknown> {
    switch (name) {
      case 'localink.health_status': {
        if (!toolSchemas[name].safeParse(args).success) invalidInput();
        return this.runtime.health();
      }
      case 'localink.capability_search':
      case 'localink.skill_search': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        const { query, limit = 20 } = result.data;
        const items =
          name === 'localink.capability_search'
            ? this.runtime.capabilities.search(query).map(capabilityMetadata)
            : this.runtime.skills.search(query);
        return {
          items: items.slice(0, limit),
          total: items.length,
          hasMore: items.length > limit,
        };
      }
      case 'localink.capability_describe': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return capabilityMetadata(
          this.runtime.capabilities.describe(result.data.capabilityId),
        );
      }
      case 'localink.capability_invoke': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        const { capabilityId, input, fixtureContext } = result.data;
        const context: CapabilityInvokeContext = {
          policyProfile: fixtureContext?.policyProfile ?? 'balanced',
          ...(fixtureContext?.identity === undefined
            ? {}
            : { identity: fixtureContext.identity }),
          ...(fixtureContext?.grantedScopes === undefined
            ? {}
            : { grantedScopes: fixtureContext.grantedScopes }),
        };
        this.runtime.validateInput(capabilityId, input);
        return this.runtime.capabilities.invoke(capabilityId, input, context);
      }
      case 'localink.skill_read': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return {
          trust: 'untrusted-asset',
          ...this.runtime.skills.read(
            result.data.skillId,
            result.data.maxBytes ?? 8192,
          ),
        };
      }
    }
  }
}
