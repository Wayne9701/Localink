import { createHash } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityRegistry } from '@localink/core';
import {
  CONTRACT_VERSION_V1,
  LocalinkError,
  type CapabilityDescriptor,
} from '@localink/sdk';
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const EXTERNAL_MCP_SCHEMA_VERSION = 1;
export const EXTERNAL_MCP_MODULE_ID = 'localink.external_mcp';
export const EXTERNAL_MCP_LIMITS = {
  providers: 20,
  toolsPerProvider: 1000,
  args: 64,
  argumentBytes: 4096,
  totalArgumentBytes: 32 * 1024,
  schemaBytes: 64 * 1024,
  connectTimeoutMs: 5_000,
  callTimeoutMs: 30_000,
  transportBufferBytes: 1024 * 1024,
} as const;

const SAFE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SECRET_ARGUMENT =
  /(?:^|[-_])(token|cookie|password|passwd|api[-_]?key|client[-_]?secret|oauth)(?:$|[=_-])/iu;

export interface LoopbackHttpProvider {
  readonly id: string;
  readonly transport: 'loopback-http';
  readonly url: string;
  readonly enabled: boolean;
}

export interface StdioProvider {
  readonly id: string;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly enabled: boolean;
}

export type ExternalMcpProvider = LoopbackHttpProvider | StdioProvider;

export interface ExternalMcpConfig {
  readonly version: typeof EXTERNAL_MCP_SCHEMA_VERSION;
  readonly providers: readonly unknown[];
}

export interface ExternalMcpStoreLike {
  read(): Promise<ExternalMcpConfig | undefined>;
  write(value: ExternalMcpConfig): Promise<ExternalMcpConfig>;
}

export interface ExternalMcpProviderStatus {
  id: string;
  transport: ExternalMcpProvider['transport'] | 'invalid';
  state: 'ready' | 'disabled' | 'degraded';
  eligibleReadTools: number;
  skippedTools: number;
  reasonCode?: string;
}

export interface ExternalMcpHealth {
  readonly providerCount: number;
  readonly readyProviders: number;
  readonly degradedProviders: number;
  readonly registeredReadCapabilities: number;
  readonly providers: readonly ExternalMcpProviderStatus[];
}

interface ProviderConnection {
  readonly client: Client;
  readonly transport: Transport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validateExternalMcpConfig(value: unknown): ExternalMcpConfig {
  if (
    !isRecord(value) ||
    !strictKeys(value, ['version', 'providers']) ||
    value.version !== EXTERNAL_MCP_SCHEMA_VERSION ||
    !Array.isArray(value.providers) ||
    value.providers.length > EXTERNAL_MCP_LIMITS.providers
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'External MCP config must use bounded schema version 1.',
    );
  }
  return {
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: structuredClone(value.providers),
  };
}

function parseLoopbackUrl(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0'))
    throw new LocalinkError('CONFIG_INVALID', 'Provider URL is invalid.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalinkError('CONFIG_INVALID', 'Provider URL is invalid.');
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'External HTTP providers must use credential-free loopback HTTP.',
    );
  }
  return url.href;
}

async function loopbackFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, { ...init, redirect: 'manual' });
  parseLoopbackUrl(request.url);
  const response = await fetch(request);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('provider-redirect-rejected');
  }
  return response;
}

function parseArgs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > EXTERNAL_MCP_LIMITS.args ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        item.includes('\0') ||
        Buffer.byteLength(item) > EXTERNAL_MCP_LIMITS.argumentBytes ||
        SECRET_ARGUMENT.test(item),
    ) ||
    value.reduce((bytes, item) => bytes + Buffer.byteLength(String(item)), 0) >
      EXTERNAL_MCP_LIMITS.totalArgumentBytes
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Provider args are invalid, unbounded, or secret-like.',
    );
  }
  return [...(value as string[])];
}

export function parseExternalMcpProvider(value: unknown): ExternalMcpProvider {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !SAFE_ID.test(value.id) ||
    typeof value.enabled !== 'boolean'
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Provider contains invalid fields.',
    );
  }
  if (value.transport === 'loopback-http') {
    if (!strictKeys(value, ['id', 'transport', 'url', 'enabled']))
      throw new LocalinkError(
        'CONFIG_INVALID',
        'HTTP provider contains unsupported or secret fields.',
      );
    return {
      id: value.id,
      transport: 'loopback-http',
      url: parseLoopbackUrl(value.url),
      enabled: value.enabled,
    };
  }
  if (value.transport === 'stdio') {
    if (
      !strictKeys(value, ['id', 'transport', 'command', 'args', 'enabled']) ||
      typeof value.command !== 'string' ||
      !path.isAbsolute(value.command) ||
      value.command.includes('\0')
    ) {
      throw new LocalinkError(
        'CONFIG_INVALID',
        'Stdio provider requires an absolute command and no secret fields.',
      );
    }
    return {
      id: value.id,
      transport: 'stdio',
      command: path.resolve(value.command),
      args: parseArgs(value.args),
      enabled: value.enabled,
    };
  }
  throw new LocalinkError(
    'CONFIG_INVALID',
    'Provider transport is unsupported.',
  );
}

export function validExternalMcpProviders(
  config?: ExternalMcpConfig,
): ExternalMcpProvider[] {
  const providers: ExternalMcpProvider[] = [];
  const seen = new Set<string>();
  for (const item of config?.providers ?? []) {
    try {
      const provider = parseExternalMcpProvider(item);
      if (seen.has(provider.id)) continue;
      seen.add(provider.id);
      providers.push(provider);
    } catch {
      // Invalid entries are isolated and represented in health.
    }
  }
  return providers;
}

function providerEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const allowed = new Set([
    'HOME',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'USER',
    'TMPDIR',
    'LANG',
  ]);
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && (allowed.has(key) || key.startsWith('LC_')))
      selected[key] = value;
  }
  return selected;
}

async function assertExecutable(command: string): Promise<void> {
  const info = await stat(command);
  if (!info.isFile()) throw new Error('not-file');
  await access(command, constants.X_OK);
}

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function safeToolSegment(name: string): string {
  const normalized = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72);
  return /^[a-z]/u.test(normalized)
    ? normalized
    : `tool-${normalized || 'read'}`;
}

export function externalCapabilityId(
  providerId: string,
  toolName: string,
): string {
  const hash = createHash('sha256')
    .update(`${providerId}\0${toolName}`)
    .digest('hex')
    .slice(0, 8);
  return `mcp.${providerId}.${safeToolSegment(toolName)}_${hash}`;
}

function projectedSchema(tool: Tool): Readonly<Record<string, unknown>> {
  const value = tool.inputSchema;
  if (!isRecord(value)) throw new Error('invalid-schema');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > EXTERNAL_MCP_LIMITS.schemaBytes)
    throw new Error('oversized-schema');
  return JSON.parse(serialized) as Record<string, unknown>;
}

function capabilityDescriptor(
  provider: ExternalMcpProvider,
  tool: Tool,
): CapabilityDescriptor {
  return {
    contractVersion: CONTRACT_VERSION_V1,
    id: externalCapabilityId(provider.id, tool.name),
    moduleId: EXTERNAL_MCP_MODULE_ID,
    version: '1.0.0-external-mcp-v1',
    title: `${tool.title ?? tool.name} (${provider.id})`,
    description: `${tool.description ?? 'External MCP read tool.'} Provider: ${provider.id}; original tool: ${tool.name}.`,
    inputSchema: { kind: 'inline', schema: projectedSchema(tool) },
    outputSummary: 'Bounded external MCP CallToolResult.',
    operationClass: 'read',
    requiredScopes: [],
    riskTier: 0,
    reversible: true,
    supportsPrecondition: false,
    postVerify: 'none',
    publicSemantic: false,
  };
}

async function closeConnection(connection: ProviderConnection): Promise<void> {
  await connection.client.close().catch(() => undefined);
  await connection.transport.close().catch(() => undefined);
}

export class ExternalMcpManager {
  readonly #registry: CapabilityRegistry;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #connections = new Map<string, ProviderConnection>();
  readonly #statuses: ExternalMcpProviderStatus[] = [];
  #providerCount = 0;
  #closed = false;

  constructor(registry: CapabilityRegistry, environment: NodeJS.ProcessEnv) {
    this.#registry = registry;
    this.#environment = environment;
  }

  async load(config?: ExternalMcpConfig): Promise<void> {
    const providers = validExternalMcpProviders(config);
    this.#providerCount = config?.providers.length ?? 0;
    const invalidEntries = this.#providerCount - providers.length;
    for (let index = 0; index < invalidEntries; index++) {
      this.#statuses.push({
        id: `invalid-provider-${index + 1}`,
        transport: 'invalid',
        state: 'degraded',
        eligibleReadTools: 0,
        skippedTools: 0,
        reasonCode: 'PROVIDER_CONFIG_INVALID',
      });
    }
    await Promise.all(
      providers.map((provider) => this.#loadProvider(provider)),
    );
    this.#statuses.sort((left, right) => left.id.localeCompare(right.id));
  }

  health(): ExternalMcpHealth {
    return {
      providerCount: this.#providerCount,
      readyProviders: this.#statuses.filter((item) => item.state === 'ready')
        .length,
      degradedProviders: this.#statuses.filter(
        (item) => item.state === 'degraded',
      ).length,
      registeredReadCapabilities: this.#statuses.reduce(
        (count, item) => count + item.eligibleReadTools,
        0,
      ),
      providers: this.#statuses.map((item) => ({ ...item })),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.all(connections.map(closeConnection));
  }

  async #loadProvider(provider: ExternalMcpProvider): Promise<void> {
    if (!provider.enabled) {
      this.#statuses.push({
        id: provider.id,
        transport: provider.transport,
        state: 'disabled',
        eligibleReadTools: 0,
        skippedTools: 0,
      });
      return;
    }
    let connection: ProviderConnection | undefined;
    try {
      if (provider.transport === 'stdio')
        await assertExecutable(provider.command);
      const transport: Transport =
        provider.transport === 'loopback-http'
          ? new StreamableHTTPClientTransport(new URL(provider.url), {
              fetch: loopbackFetch,
            })
          : new StdioClientTransport({
              command: provider.command,
              args: [...provider.args],
              env: providerEnvironment(this.#environment),
              stderr: 'pipe',
              maxBufferSize: EXTERNAL_MCP_LIMITS.transportBufferBytes,
            });
      const client = new Client(
        {
          name: `localink-provider-${provider.id}`,
          version: '0.1.0',
        },
        {
          versionNegotiation: {
            mode: 'auto',
            probe: { timeoutMs: EXTERNAL_MCP_LIMITS.connectTimeoutMs },
          },
        },
      );
      connection = { client, transport };
      await within(
        client.connect(transport),
        EXTERNAL_MCP_LIMITS.connectTimeoutMs,
        'provider-connect-timeout',
      );
      const listedTools = (
        await within(
          client.listTools(),
          EXTERNAL_MCP_LIMITS.connectTimeoutMs,
          'provider-list-timeout',
        )
      ).tools;
      const tools = listedTools.slice(0, EXTERNAL_MCP_LIMITS.toolsPerProvider);
      let eligibleReadTools = 0;
      let skippedTools = listedTools.length - tools.length;
      const status: ExternalMcpProviderStatus = {
        id: provider.id,
        transport: provider.transport,
        state: 'ready',
        eligibleReadTools: 0,
        skippedTools: 0,
      };
      for (const tool of tools) {
        if (
          tool.annotations?.readOnlyHint !== true ||
          tool.annotations.destructiveHint === true
        ) {
          skippedTools++;
          continue;
        }
        try {
          const descriptor = capabilityDescriptor(provider, tool);
          const fixedToolName = tool.name;
          this.#registry.register(descriptor, async (input) => {
            try {
              if (!isRecord(input)) {
                throw new LocalinkError(
                  'INVALID_ARGUMENT',
                  'External MCP tool input must be an object.',
                );
              }
              const output = await within(
                client.callTool({ name: fixedToolName, arguments: input }),
                EXTERNAL_MCP_LIMITS.callTimeoutMs,
                'provider-call-timeout',
              );
              return { output };
            } catch (error) {
              status.state = 'degraded';
              status.reasonCode = 'PROVIDER_CALL_FAILED';
              throw error;
            }
          });
          eligibleReadTools++;
        } catch {
          skippedTools++;
        }
      }
      status.eligibleReadTools = eligibleReadTools;
      status.skippedTools = skippedTools;
      this.#connections.set(provider.id, connection);
      this.#statuses.push(status);
    } catch {
      if (connection !== undefined) await closeConnection(connection);
      this.#statuses.push({
        id: provider.id,
        transport: provider.transport,
        state: 'degraded',
        eligibleReadTools: 0,
        skippedTools: 0,
        reasonCode: 'PROVIDER_UNAVAILABLE',
      });
    }
  }
}

export async function addExternalMcpProvider(
  store: ExternalMcpStoreLike,
  providerValue: ExternalMcpProvider,
): Promise<ExternalMcpProvider> {
  const provider = parseExternalMcpProvider(providerValue);
  if (provider.transport === 'stdio') await assertExecutable(provider.command);
  const config = (await store.read()) ?? {
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: [],
  };
  const providers = validExternalMcpProviders(config);
  if (providers.some((item) => item.id === provider.id))
    throw new LocalinkError('ALREADY_EXISTS', 'MCP provider already exists.');
  if (providers.length >= EXTERNAL_MCP_LIMITS.providers)
    throw new LocalinkError(
      'SIZE_LIMIT_EXCEEDED',
      'MCP provider limit reached.',
    );
  await store.write({
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: [...providers, provider],
  });
  return provider;
}

export async function removeExternalMcpProvider(
  store: ExternalMcpStoreLike,
  id: string,
): Promise<ExternalMcpProvider> {
  const config = (await store.read()) ?? {
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: [],
  };
  const providers = validExternalMcpProviders(config);
  const provider = providers.find((item) => item.id === id);
  if (provider === undefined)
    throw new LocalinkError('NOT_FOUND', 'MCP provider was not found.');
  await store.write({
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: providers.filter((item) => item.id !== id),
  });
  return provider;
}
