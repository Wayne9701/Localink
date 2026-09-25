import { createHash } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityRegistry } from '@localink/core';
import {
  CONTRACT_VERSION_V1,
  LocalinkError,
  RICH_IMAGE_HARD_MAX_BYTES,
  RICH_IMAGE_MIME_TYPES,
  validateRichImageBlock,
  type CapabilityDescriptor,
  type RichImageBlock,
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
  riskOverridesPerProvider: 256,
  riskOverrideNameBytes: 256,
  riskOverrideBytes: 32 * 1024,
  args: 64,
  argumentBytes: 4096,
  totalArgumentBytes: 32 * 1024,
  schemaBytes: 64 * 1024,
  connectTimeoutMs: 5_000,
  callTimeoutMs: 30_000,
  transportBufferBytes: 1024 * 1024,
  richMetadataBytes: 64 * 1024,
  richTransportHeadroomBytes: 256 * 1024,
  richTransportHardMaxBytes: 8 * 1024 * 1024,
} as const;

const SAFE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SECRET_ARGUMENT =
  /(?:^|[-_])(token|cookie|password|passwd|api[-_]?key|client[-_]?secret|oauth)(?:$|[=_-])/iu;
const EXACT_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

export type ExternalMcpRiskTier = 0 | 1 | 2;
export type ExternalMcpToolRiskOverrides = Readonly<
  Record<string, ExternalMcpRiskTier>
>;

export interface ExternalMcpRichContentPolicy {
  readonly images: {
    readonly enabled: boolean;
    readonly maxDecodedBytes?: number;
    readonly maxBlocks?: 1;
    readonly mimeTypes?: readonly ('image/png' | 'image/jpeg')[];
  };
}

export interface LoopbackHttpProvider {
  readonly id: string;
  readonly transport: 'loopback-http';
  readonly url: string;
  readonly enabled: boolean;
  readonly toolRiskOverrides?: ExternalMcpToolRiskOverrides;
  readonly richContent?: ExternalMcpRichContentPolicy;
}

export interface StdioProvider {
  readonly id: string;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly enabled: boolean;
  readonly toolRiskOverrides?: ExternalMcpToolRiskOverrides;
  readonly richContent?: ExternalMcpRichContentPolicy;
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
  eligibleProjectedTools: number;
  projectedToolsByTier: Readonly<Record<ExternalMcpRiskTier, number>>;
  skippedTools: number;
  reasonCode?: string;
}

export interface ExternalMcpHealth {
  readonly providerCount: number;
  readonly readyProviders: number;
  readonly degradedProviders: number;
  readonly registeredReadCapabilities: number;
  readonly registeredCapabilities: number;
  readonly registeredCapabilitiesByTier: Readonly<
    Record<ExternalMcpRiskTier, number>
  >;
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

function parseToolRiskOverrides(
  value: unknown,
): ExternalMcpToolRiskOverrides | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Tool risk overrides must be an exact-name object.',
    );
  }
  const entries = Object.entries(value);
  if (
    entries.length > EXTERNAL_MCP_LIMITS.riskOverridesPerProvider ||
    Buffer.byteLength(JSON.stringify(value)) >
      EXTERNAL_MCP_LIMITS.riskOverrideBytes ||
    entries.some(
      ([name, tier]) =>
        !EXACT_TOOL_NAME.test(name) ||
        Buffer.byteLength(name) > EXTERNAL_MCP_LIMITS.riskOverrideNameBytes ||
        ![0, 1, 2].includes(Number(tier)) ||
        typeof tier !== 'number',
    )
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Tool risk overrides must use bounded exact names and tiers 0, 1, or 2.',
    );
  }
  return Object.fromEntries(entries) as Record<string, ExternalMcpRiskTier>;
}

function parseRichContent(
  value: unknown,
): ExternalMcpRichContentPolicy | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !strictKeys(value, ['images']) ||
    !isRecord(value.images)
  )
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Rich content policy is invalid.',
    );
  const images = value.images;
  if (images.enabled === false && strictKeys(images, ['enabled']))
    return { images: { enabled: false } };
  if (
    images.enabled !== true ||
    !strictKeys(images, [
      'enabled',
      'maxDecodedBytes',
      'maxBlocks',
      'mimeTypes',
    ]) ||
    !Number.isSafeInteger(images.maxDecodedBytes) ||
    (images.maxDecodedBytes as number) < 1 ||
    (images.maxDecodedBytes as number) > RICH_IMAGE_HARD_MAX_BYTES ||
    images.maxBlocks !== 1 ||
    !Array.isArray(images.mimeTypes) ||
    images.mimeTypes.length < 1 ||
    images.mimeTypes.length > 2 ||
    new Set(images.mimeTypes).size !== images.mimeTypes.length ||
    images.mimeTypes.some((mime) => !RICH_IMAGE_MIME_TYPES.includes(mime))
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Rich image policy exceeds bounds.',
    );
  }
  return {
    images: {
      enabled: true,
      maxDecodedBytes: images.maxDecodedBytes as number,
      maxBlocks: 1,
      mimeTypes: images.mimeTypes as ('image/png' | 'image/jpeg')[],
    },
  };
}

export function externalMcpTransportBufferBytes(
  provider: ExternalMcpProvider,
): number {
  const images = provider.richContent?.images;
  if (provider.transport !== 'stdio' || images?.enabled !== true)
    return EXTERNAL_MCP_LIMITS.transportBufferBytes;
  const size = images.maxDecodedBytes;
  if (
    !Number.isSafeInteger(size) ||
    size === undefined ||
    size < 1 ||
    size > RICH_IMAGE_HARD_MAX_BYTES
  )
    throw new LocalinkError('CONFIG_INVALID', 'Rich image size is invalid.');
  return Math.min(
    EXTERNAL_MCP_LIMITS.richTransportHardMaxBytes,
    Math.max(
      EXTERNAL_MCP_LIMITS.transportBufferBytes,
      Math.ceil(size / 3) * 4 + EXTERNAL_MCP_LIMITS.richTransportHeadroomBytes,
    ),
  );
}

function normalizeRichResult(
  output: unknown,
  provider: ExternalMcpProvider,
  eligible: boolean,
): { output: unknown; richContent?: readonly RichImageBlock[] } {
  if (!isRecord(output) || !Array.isArray(output.content)) return { output };
  if (
    provider.richContent?.images.enabled === true &&
    output.content.some(
      (block: unknown) =>
        !isRecord(block) || !['text', 'image'].includes(String(block.type)),
    )
  ) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Unsupported rich content block.',
    );
  }
  const images = output.content.filter(
    (block: unknown) => isRecord(block) && block.type === 'image',
  );
  if (images.length === 0) return { output };
  if (!eligible || output.isError === true || images.length !== 1) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Rich image result is not eligible.',
    );
  }
  const policy = provider.richContent?.images;
  if (
    policy?.enabled !== true ||
    policy.maxDecodedBytes === undefined ||
    policy.mimeTypes === undefined
  )
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Rich image policy is unavailable.',
    );
  const image = validateRichImageBlock(
    images[0],
    policy.maxDecodedBytes,
    policy.mimeTypes,
  );
  const metadata = {
    ...output,
    content: output.content.filter(
      (block: unknown) => isRecord(block) && block.type === 'text',
    ),
  };
  const serialized = JSON.stringify(metadata);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized) > EXTERNAL_MCP_LIMITS.richMetadataBytes ||
    serialized.includes(image.data)
  ) {
    throw new LocalinkError(
      'SIZE_LIMIT_EXCEEDED',
      'Rich image metadata exceeds boundary.',
    );
  }
  return { output: JSON.parse(serialized) as unknown, richContent: [image] };
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
  const toolRiskOverrides = parseToolRiskOverrides(value.toolRiskOverrides);
  const richContent = parseRichContent(value.richContent);
  if (value.transport === 'loopback-http') {
    if (
      !strictKeys(value, [
        'id',
        'transport',
        'url',
        'enabled',
        'toolRiskOverrides',
        'richContent',
      ])
    )
      throw new LocalinkError(
        'CONFIG_INVALID',
        'HTTP provider contains unsupported or secret fields.',
      );
    return {
      id: value.id,
      transport: 'loopback-http',
      url: parseLoopbackUrl(value.url),
      enabled: value.enabled,
      ...(toolRiskOverrides === undefined ? {} : { toolRiskOverrides }),
      ...(richContent === undefined ? {} : { richContent }),
    };
  }
  if (value.transport === 'stdio') {
    if (
      !strictKeys(value, [
        'id',
        'transport',
        'command',
        'args',
        'enabled',
        'toolRiskOverrides',
        'richContent',
      ]) ||
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
      ...(toolRiskOverrides === undefined ? {} : { toolRiskOverrides }),
      ...(richContent === undefined ? {} : { richContent }),
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
  riskTier: ExternalMcpRiskTier,
  riskSource: 'annotations' | 'local exact-name override',
): CapabilityDescriptor {
  return {
    contractVersion: CONTRACT_VERSION_V1,
    id: externalCapabilityId(provider.id, tool.name),
    moduleId: EXTERNAL_MCP_MODULE_ID,
    version: '1.0.0-external-mcp-v2',
    title: `${tool.title ?? tool.name} (${provider.id})`,
    description: `${tool.description ?? 'External MCP tool.'} Provider: ${provider.id}; original tool: ${tool.name}; Localink risk tier ${riskTier} from ${riskSource}.`,
    inputSchema: { kind: 'inline', schema: projectedSchema(tool) },
    outputSummary: 'Bounded external MCP CallToolResult.',
    operationClass: riskTier === 0 ? 'read' : 'write',
    requiredScopes: [],
    riskTier,
    reversible: riskTier === 0,
    supportsPrecondition: false,
    postVerify: 'none',
    publicSemantic: false,
  };
}

function annotationRiskTier(tool: Tool): ExternalMcpRiskTier | undefined {
  const annotations = tool.annotations;
  if (!isRecord(annotations)) return undefined;
  if (
    annotations.destructiveHint === true ||
    annotations.openWorldHint === true
  ) {
    return 2;
  }
  if (annotations.readOnlyHint === true) return 0;
  if (annotations.readOnlyHint === false) return 1;
  return undefined;
}

function emptyTierCounts(): Record<ExternalMcpRiskTier, number> {
  return { 0: 0, 1: 0, 2: 0 };
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
        eligibleProjectedTools: 0,
        projectedToolsByTier: emptyTierCounts(),
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
    const tierCounts = this.#statuses.reduce((counts, item) => {
      counts[0] += item.projectedToolsByTier[0];
      counts[1] += item.projectedToolsByTier[1];
      counts[2] += item.projectedToolsByTier[2];
      return counts;
    }, emptyTierCounts());
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
      registeredCapabilities: tierCounts[0] + tierCounts[1] + tierCounts[2],
      registeredCapabilitiesByTier: tierCounts,
      providers: this.#statuses.map((item) => ({
        ...item,
        projectedToolsByTier: { ...item.projectedToolsByTier },
      })),
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
        eligibleProjectedTools: 0,
        projectedToolsByTier: emptyTierCounts(),
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
              maxBufferSize: externalMcpTransportBufferBytes(provider),
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
      const projectedToolsByTier = emptyTierCounts();
      let skippedTools = listedTools.length - tools.length;
      const status: ExternalMcpProviderStatus = {
        id: provider.id,
        transport: provider.transport,
        state: 'ready',
        eligibleReadTools: 0,
        eligibleProjectedTools: 0,
        projectedToolsByTier,
        skippedTools: 0,
      };
      const listedNames = new Set(tools.map((tool) => tool.name));
      const unknownOverrides = Object.keys(
        provider.toolRiskOverrides ?? {},
      ).filter((name) => !listedNames.has(name));
      if (unknownOverrides.length > 0) {
        status.state = 'degraded';
        status.reasonCode = 'PROVIDER_TOOL_OVERRIDE_UNKNOWN';
      }
      let providerCallAvailable = true;
      for (const tool of tools) {
        const override = Object.hasOwn(
          provider.toolRiskOverrides ?? {},
          tool.name,
        )
          ? provider.toolRiskOverrides?.[tool.name]
          : undefined;
        const riskTier = override ?? annotationRiskTier(tool);
        if (riskTier === undefined) {
          skippedTools++;
          continue;
        }
        try {
          const descriptor = capabilityDescriptor(
            provider,
            tool,
            riskTier,
            override === undefined
              ? 'annotations'
              : 'local exact-name override',
          );
          const fixedToolName = tool.name;
          const richEligible =
            riskTier === 0 &&
            provider.richContent?.images.enabled === true &&
            tool.annotations?.readOnlyHint === true &&
            tool.annotations?.destructiveHint !== true &&
            tool.annotations?.openWorldHint !== true;
          this.#registry.register(descriptor, async (input) => {
            try {
              if (!providerCallAvailable) throw new Error('provider-degraded');
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
              return normalizeRichResult(output, provider, richEligible);
            } catch (error) {
              providerCallAvailable = false;
              status.state = 'degraded';
              status.reasonCode = 'PROVIDER_CALL_FAILED';
              throw error;
            }
          });
          projectedToolsByTier[riskTier]++;
          if (riskTier === 0) eligibleReadTools++;
        } catch {
          skippedTools++;
        }
      }
      status.eligibleReadTools = eligibleReadTools;
      status.eligibleProjectedTools =
        projectedToolsByTier[0] +
        projectedToolsByTier[1] +
        projectedToolsByTier[2];
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
        eligibleProjectedTools: 0,
        projectedToolsByTier: emptyTierCounts(),
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

function providerWithOverrides(
  provider: ExternalMcpProvider,
  overrides: ExternalMcpToolRiskOverrides | undefined,
): ExternalMcpProvider {
  const { toolRiskOverrides: _previous, ...base } = provider;
  void _previous;
  return {
    ...base,
    ...(overrides === undefined || Object.keys(overrides).length === 0
      ? {}
      : { toolRiskOverrides: overrides }),
  } as ExternalMcpProvider;
}

async function configuredProvider(
  store: ExternalMcpStoreLike,
  id: string,
): Promise<{
  providers: ExternalMcpProvider[];
  provider: ExternalMcpProvider;
}> {
  const config = (await store.read()) ?? {
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: [],
  };
  const providers = validExternalMcpProviders(config);
  const provider = providers.find((item) => item.id === id);
  if (provider === undefined)
    throw new LocalinkError('NOT_FOUND', 'MCP provider was not found.');
  return { providers, provider };
}

export async function listExternalMcpToolRiskOverrides(
  store: ExternalMcpStoreLike,
  id: string,
): Promise<ExternalMcpToolRiskOverrides> {
  const { provider } = await configuredProvider(store, id);
  return { ...(provider.toolRiskOverrides ?? {}) };
}

export async function setExternalMcpToolRiskOverride(
  store: ExternalMcpStoreLike,
  id: string,
  toolName: string,
  riskTier: number,
): Promise<ExternalMcpProvider> {
  const parsed = parseToolRiskOverrides({ [toolName]: riskTier });
  if (parsed === undefined)
    throw new LocalinkError('CONFIG_INVALID', 'Tool risk override is invalid.');
  const { providers, provider } = await configuredProvider(store, id);
  const overrides = parseToolRiskOverrides({
    ...(provider.toolRiskOverrides ?? {}),
    ...parsed,
  });
  const updated = providerWithOverrides(provider, overrides);
  await store.write({
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: providers.map((item) => (item.id === id ? updated : item)),
  });
  return updated;
}

export async function removeExternalMcpToolRiskOverride(
  store: ExternalMcpStoreLike,
  id: string,
  toolName: string,
): Promise<ExternalMcpProvider> {
  const { providers, provider } = await configuredProvider(store, id);
  if (!Object.hasOwn(provider.toolRiskOverrides ?? {}, toolName)) {
    throw new LocalinkError('NOT_FOUND', 'Tool risk override was not found.');
  }
  const overrides = { ...(provider.toolRiskOverrides ?? {}) };
  delete overrides[toolName];
  const updated = providerWithOverrides(provider, overrides);
  await store.write({
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: providers.map((item) => (item.id === id ? updated : item)),
  });
  return updated;
}

export async function setExternalMcpRichImagePolicy(
  store: ExternalMcpStoreLike,
  id: string,
  maxDecodedBytes: number | undefined,
): Promise<ExternalMcpProvider> {
  const { providers, provider } = await configuredProvider(store, id);
  const { richContent: _previous, ...base } = provider;
  void _previous;
  const candidate = {
    ...base,
    ...(maxDecodedBytes === undefined
      ? {}
      : {
          richContent: {
            images: {
              enabled: true,
              maxDecodedBytes,
              maxBlocks: 1,
              mimeTypes: [...RICH_IMAGE_MIME_TYPES],
            },
          },
        }),
  };
  const updated = parseExternalMcpProvider(candidate);
  await store.write({
    version: EXTERNAL_MCP_SCHEMA_VERSION,
    providers: providers.map((item) => (item.id === id ? updated : item)),
  });
  return updated;
}
