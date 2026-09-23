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
  fixtureToolSchemas,
  INPUT_LIMIT_BYTES,
  PUBLIC_FILE_LIMITS,
  PUBLIC_GIT_LIMITS,
  PUBLIC_PROCESS_LIMITS,
  toolSchemas,
  type ToolName,
} from './tool-definitions.js';

function nativeRuntime(runtime: PublicRuntime) {
  if (runtime.native === undefined) {
    throw new LocalinkError(
      'CAPABILITY_UNAVAILABLE',
      'Native tools are unavailable in this explicit fixture runtime.',
    );
  }
  return runtime.native;
}

function usesWorkspace(name: string): boolean {
  return (
    name === 'localink.workspace_list' ||
    name === 'localink.workspace_inspect' ||
    name.startsWith('localink.files_') ||
    name.startsWith('localink.git_') ||
    name === 'localink.process_exec' ||
    name === 'localink.process_start'
  );
}

async function itemResult<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<
  | { path: string; ok: true; value: T }
  | { path: string; ok: false; error: ReturnType<typeof publicError> }
> {
  try {
    return { path, ok: true, value: await operation() };
  } catch (error) {
    return { path, ok: false, error: publicError(error) };
  }
}

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
    readonly allowFixtureContext = false,
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
      if (usesWorkspace(name)) await this.runtime.refreshWorkspaces?.();
      if (name.startsWith('localink.process_'))
        await this.runtime.refreshProcessPolicy?.();
      if (name === 'localink.skill_search' || name === 'localink.skill_read')
        await this.runtime.refreshSkillSources?.();
      if (name.startsWith('localink.capability_'))
        await this.runtime.refreshExternalMcp?.();
      const inputLimit =
        name === 'localink.git_apply_patch'
          ? PUBLIC_GIT_LIMITS.patchBytes + 4096
          : INPUT_LIMIT_BYTES;
      if (Buffer.byteLength(JSON.stringify(args) ?? '') > inputLimit) {
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
        const result = (
          this.allowFixtureContext
            ? fixtureToolSchemas[name]
            : toolSchemas[name]
        ).safeParse(args);
        if (!result.success) invalidInput();
        const invocation = result.data as {
          capabilityId: string;
          input: unknown;
          fixtureContext?: {
            policyProfile?: 'open' | 'balanced' | 'strict';
            identity?: { id: 'alice' | 'bob'; type: 'fixture-user' };
            grantedScopes?: ('fixture:read' | 'fixture:write')[];
          };
        };
        const { capabilityId, input, fixtureContext } = invocation;
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
      case 'localink.workspace_list': {
        if (!toolSchemas[name].safeParse(args).success) invalidInput();
        return { workspaces: nativeRuntime(this.runtime).workspaceList() };
      }
      case 'localink.workspace_inspect': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).workspaceInspect(
          result.data.workspaceId,
        );
      }
      case 'localink.files_list': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        const { workspaceId, relativePath, limit } = result.data;
        return nativeRuntime(this.runtime).files.list(
          workspaceId,
          relativePath ?? '',
          limit,
        );
      }
      case 'localink.files_read_many': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        const native = nativeRuntime(this.runtime);
        const maxBytes =
          result.data.maxBytesPerFile ?? PUBLIC_FILE_LIMITS.defaultReadBytes;
        return {
          items: await Promise.all(
            result.data.paths.map((path) =>
              itemResult(path, () =>
                native.files.readText(result.data.workspaceId, path, maxBytes),
              ),
            ),
          ),
        };
      }
      case 'localink.files_inspect_many': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        const native = nativeRuntime(this.runtime);
        return {
          items: await Promise.all(
            result.data.paths.map((path) =>
              itemResult(path, async () => {
                const entry = await native.files.inspect(
                  result.data.workspaceId,
                  path,
                );
                if (result.data.includeSha256 !== true || entry.kind !== 'file')
                  return entry;
                if (entry.size > PUBLIC_FILE_LIMITS.hardReadBytes) {
                  throw new LocalinkError(
                    'SIZE_LIMIT_EXCEEDED',
                    'File exceeds the public inspect hash bound.',
                  );
                }
                return {
                  ...entry,
                  sha256: await native.files.sha256(
                    result.data.workspaceId,
                    path,
                  ),
                };
              }),
            ),
          ),
        };
      }
      case 'localink.files_search': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        const { workspaceId, query, mode, relativePath, maxMatches } =
          result.data;
        const options = {
          ...(relativePath === undefined ? {} : { relativePath }),
          maxMatches: maxMatches ?? PUBLIC_FILE_LIMITS.searchMatches,
        };
        const files = nativeRuntime(this.runtime).files;
        return mode === 'path'
          ? files.searchPaths(workspaceId, query, options)
          : files.searchContent(workspaceId, query, options);
      }
      case 'localink.files_create_text': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).files.createText(
          result.data.workspaceId,
          result.data.relativePath,
          result.data.text,
        );
      }
      case 'localink.files_precise_edit': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).preciseEdit({
          workspaceId: result.data.workspaceId,
          relativePath: result.data.relativePath,
          expectedText: result.data.expectedText,
          replacementText: result.data.replacementText,
          ...(result.data.expectedSha256 === undefined
            ? {}
            : { expectedSha256: result.data.expectedSha256 }),
          ...(result.data.expectedOccurrences === undefined
            ? {}
            : { expectedOccurrences: result.data.expectedOccurrences }),
        });
      }
      case 'localink.files_move': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).files.move(
          result.data.workspaceId,
          result.data.sourceRelativePath,
          result.data.destinationRelativePath,
        );
      }
      case 'localink.files_archive': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        const receipt = await nativeRuntime(this.runtime).files.archive(
          result.data.workspaceId,
          result.data.relativePath,
        );
        return {
          workspaceId: receipt.workspaceId,
          originalRelativePath: receipt.originalRelativePath,
          byteLength: receipt.byteLength,
          sha256: receipt.sha256,
          movedAt: receipt.movedAt,
          crossDeviceFallback: receipt.crossDeviceFallback,
          archived: true,
        };
      }
      case 'localink.process_exec': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).processExec({
          workspaceId: result.data.workspaceId,
          command: result.data.command,
          ...(result.data.args === undefined ? {} : { args: result.data.args }),
          ...(result.data.cwd === undefined ? {} : { cwd: result.data.cwd }),
          timeoutMs:
            result.data.timeoutMs ?? PUBLIC_PROCESS_LIMITS.defaultExecTimeoutMs,
          maxOutputBytes:
            result.data.maxOutputBytes ??
            PUBLIC_PROCESS_LIMITS.defaultOutputBytes,
        });
      }
      case 'localink.process_start': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).processStart({
          workspaceId: result.data.workspaceId,
          command: result.data.command,
          ...(result.data.args === undefined ? {} : { args: result.data.args }),
          ...(result.data.cwd === undefined ? {} : { cwd: result.data.cwd }),
          ...(result.data.timeoutMs === undefined
            ? {}
            : { timeoutMs: result.data.timeoutMs }),
          ...(result.data.killOnTimeout === undefined
            ? {}
            : { killOnTimeout: result.data.killOnTimeout }),
          maxOutputBytes:
            result.data.maxOutputBytes ??
            PUBLIC_PROCESS_LIMITS.defaultOutputBytes,
        });
      }
      case 'localink.process_poll': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).processPoll(result.data.processId);
      }
      case 'localink.process_input': {
        const result = toolSchemas[name].safeParse(args);
        if (
          !result.success ||
          Buffer.byteLength(result.data.data) > PUBLIC_PROCESS_LIMITS.inputBytes
        )
          invalidInput();
        return nativeRuntime(this.runtime).processInput(
          result.data.processId,
          result.data.data,
        );
      }
      case 'localink.process_stop': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).processStop(
          result.data.processId,
          result.data.graceMs,
          result.data.forceKill,
        );
      }
      case 'localink.git_inspect': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).git.inspect(
          result.data.workspaceId,
          result.data.repoPath,
        );
      }
      case 'localink.git_status': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).git.status(
          result.data.workspaceId,
          result.data.repoPath,
          result.data.limit ?? PUBLIC_GIT_LIMITS.defaultStatusEntries,
        );
      }
      case 'localink.git_diff': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).git.diff({
          workspaceId: result.data.workspaceId,
          scope: result.data.scope,
          ...(result.data.repoPath === undefined
            ? {}
            : { repoPath: result.data.repoPath }),
          ...(result.data.paths === undefined
            ? {}
            : { paths: result.data.paths }),
          ...(result.data.contextLines === undefined
            ? {}
            : { contextLines: result.data.contextLines }),
          ...(result.data.maxBytes === undefined
            ? {}
            : { maxBytes: result.data.maxBytes }),
        });
      }
      case 'localink.git_log': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).git.log(
          result.data.workspaceId,
          result.data.repoPath,
          result.data.limit ?? PUBLIC_GIT_LIMITS.defaultLogEntries,
        );
      }
      case 'localink.git_apply_patch': {
        const result = toolSchemas[name].safeParse(args);
        if (!result.success) invalidInput();
        return nativeRuntime(this.runtime).git.applyPatch({
          workspaceId: result.data.workspaceId,
          patch: result.data.patch,
          expectedHead: result.data.expectedHead,
          ...(result.data.repoPath === undefined
            ? {}
            : { repoPath: result.data.repoPath }),
        });
      }
    }
  }
}
