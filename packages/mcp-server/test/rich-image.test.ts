import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  EXTERNAL_MCP_LIMITS,
  createLocalinkRuntime,
  externalMcpTransportBufferBytes,
  parseExternalMcpProvider,
} from '@localink/runtime';
import { PublicAdapter } from '../src/public-adapter.js';
import { TOOL_NAMES } from '../src/tool-definitions.js';
import { envelope, stdioEntry } from './helpers.js';

const fixture = fileURLToPath(
  new URL('./external-mcp-rich-stdio-fixture.js', import.meta.url),
);
const policy = (maxDecodedBytes = 5_000_000) => ({
  images: {
    enabled: true,
    maxDecodedBytes,
    maxBlocks: 1 as const,
    mimeTypes: ['image/png', 'image/jpeg'] as const,
  },
});

async function withProvider(
  worker: (stateRoot: string) => Promise<void>,
  rich = true,
  overrides: Record<string, 0 | 1 | 2> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-rich-image-'));
  const stateRoot = path.join(root, 'state');
  try {
    const setup = await createLocalinkRuntime({ stateRoot });
    await setup.addStdioProvider('synthetic', process.execPath, [fixture]);
    if (rich) await setup.setExternalMcpRichImagePolicy('synthetic', 5_000_000);
    for (const [name, tier] of Object.entries(overrides))
      await setup.setExternalMcpToolRiskOverride('synthetic', name, tier);
    await setup.close();
    await worker(stateRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function invoke(
  stateRoot: string,
  tool: string,
  scenario: string,
  bytes?: number,
) {
  const runtime = await createLocalinkRuntime({ stateRoot });
  try {
    const descriptor = runtime.capabilities
      .list()
      .find((item) => item.title.includes(`${tool} (synthetic)`));
    assert.ok(descriptor);
    const adapter = new PublicAdapter(runtime);
    return await adapter.call('localink.capability_invoke', {
      capabilityId: descriptor.id,
      input: { scenario, ...(bytes === undefined ? {} : { bytes }) },
    });
  } finally {
    await runtime.close();
  }
}

test('image policy is explicit, bounded, schema-v1 compatible and stdio-only for buffer growth', () => {
  const base = {
    id: 'fixture',
    transport: 'stdio' as const,
    command: process.execPath,
    args: [fixture],
    enabled: true,
  };
  assert.deepEqual(parseExternalMcpProvider(base), base);
  assert.equal(externalMcpTransportBufferBytes(base), 1024 * 1024);
  const opted = parseExternalMcpProvider({ ...base, richContent: policy() });
  assert.deepEqual(opted.richContent, policy());
  const expected =
    Math.ceil(5_000_000 / 3) * 4 +
    EXTERNAL_MCP_LIMITS.richTransportHeadroomBytes;
  assert.equal(externalMcpTransportBufferBytes(opted), expected);
  assert.ok(expected < EXTERNAL_MCP_LIMITS.richTransportHardMaxBytes);
  const http = parseExternalMcpProvider({
    id: 'local',
    transport: 'loopback-http',
    url: 'http://127.0.0.1:1234/mcp',
    enabled: true,
    richContent: policy(),
  });
  assert.equal(externalMcpTransportBufferBytes(http), 1024 * 1024);
  for (const images of [
    { ...policy().images, maxDecodedBytes: 5_000_001 },
    { ...policy().images, maxDecodedBytes: 0 },
    { ...policy().images, maxBlocks: 2 },
    { ...policy().images, mimeTypes: ['image/gif'] },
    { ...policy().images, mimeTypes: ['image/png', 'image/png'] },
  ])
    assert.throws(() =>
      parseExternalMcpProvider({ ...base, richContent: { images } }),
    );
  assert.throws(() =>
    parseExternalMcpProvider({ ...base, args: ['--api-key=synthetic-secret'] }),
  );
});

test('adapter returns bounded metadata and a top-level PNG/JPEG image only for opted native Tier0', async () => {
  await withProvider(async (stateRoot) => {
    for (const [scenario, mime] of [
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
    ] as const) {
      const result = await invoke(stateRoot, 'image_read', scenario);
      assert.equal(
        result.isError,
        false,
        `${scenario}: ${JSON.stringify(result)}`,
      );
      assert.equal(result.content.length, 2);
      assert.equal(result.content[0]?.type, 'text');
      const image = result.content[1];
      assert.equal(image?.type, 'image');
      assert.ok(image && 'data' in image);
      assert.equal(image.mimeType, mime);
      assert.equal(Buffer.from(image.data, 'base64').length, 12);
      const metadata = envelope(result);
      assert.equal((metadata.data as { status: string }).status, 'executed');
      assert.equal(JSON.stringify(metadata).includes(image.data), false);
      assert.ok(
        Buffer.byteLength(JSON.stringify(result.content[0])) < 16 * 1024,
      );
    }
  });
});

test('invalid rich blocks, duplicate data, and provider error fail closed', async () => {
  for (const scenario of [
    'invalid-base64',
    'mime-denied',
    'mismatch',
    'two-images',
    'audio',
    'audio-only',
    'resource',
    'resource-link',
    'provider-error',
    'duplicate',
    'duplicate-text',
  ]) {
    await withProvider(async (stateRoot) => {
      const result = await invoke(stateRoot, 'image_read', scenario);
      assert.equal(result.isError, true, scenario);
      assert.equal(
        result.content.some((block) => block.type === 'image'),
        false,
        scenario,
      );
    });
  }
  await withProvider(async (stateRoot) => {
    const result = await invoke(stateRoot, 'image_read', 'png', 5_000_001);
    assert.equal(result.isError, true);
    assert.equal(
      result.content.some((block) => block.type === 'image'),
      false,
    );
  });
});

test('ordinary provider result remains JSON and rich metadata stays within default bound', async () => {
  await withProvider(async (stateRoot) => {
    const ordinary = await invoke(stateRoot, 'image_read', 'plain');
    assert.equal(ordinary.isError, false);
    assert.equal(ordinary.content.length, 1);
    assert.equal(ordinary.content[0]?.type, 'text');
    assert.equal(
      (
        envelope(ordinary).data as {
          output: { structuredContent: { value: string } };
        }
      ).output.structuredContent.value,
      'ordinary result',
    );
    const rich = await invoke(stateRoot, 'image_read', 'metadata-large');
    assert.equal(rich.isError, false);
    assert.equal(rich.content[1]?.type, 'image');
    assert.equal(
      envelope(rich).truncation &&
        (envelope(rich).truncation as { truncated: boolean }).truncated,
      true,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(rich.structuredContent)) < 16 * 1024,
    );
  });
});

test('image eligibility requires opt-in, native readOnly and Tier0 despite exact overrides', async () => {
  await withProvider(async (stateRoot) => {
    const result = await invoke(stateRoot, 'image_read', 'png');
    assert.equal(result.isError, true);
    assert.equal(
      result.content.some((block) => block.type === 'image'),
      false,
    );
  }, false);
  for (const [tool, overrides] of [
    ['image_raw', { image_raw: 0 }],
    ['image_write', {}],
    ['image_open', { image_open: 0 }],
    ['image_destroy', { image_destroy: 0 }],
    ['image_read', { image_read: 1 }],
    ['image_read', { image_read: 2 }],
  ] as const) {
    await withProvider(
      async (stateRoot) => {
        const result = await invoke(stateRoot, tool, 'png');
        assert.equal(
          result.content.some((block) => block.type === 'image'),
          false,
          tool,
        );
      },
      true,
      overrides,
    );
  }
});

test(
  'rich stdio transport carries >1 MiB; default transport stays bounded; public surface remains 31',
  { timeout: 30_000 },
  async () => {
    await withProvider(async (stateRoot) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (item): item is [string, string] => item[1] !== undefined,
        ),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [stdioEntry],
        env: { ...env, LOCALINK_STATE_ROOT: stateRoot },
        maxBufferSize: 8 * 1024 * 1024,
      });
      const client = new Client(
        { name: 'rich-bridge-test', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(transport);
      try {
        const tools = await client.listTools();
        assert.deepEqual(
          tools.tools.map((tool) => tool.name),
          TOOL_NAMES,
        );
        assert.equal(tools.tools.length, 31);
        const runtime = await createLocalinkRuntime({ stateRoot });
        const descriptor = runtime.capabilities
          .list()
          .find((item) => item.title.includes('image_read (synthetic)'));
        assert.ok(descriptor);
        await runtime.close();
        for (const bytes of [1_200_000, 5_000_000]) {
          const result = await client.callTool({
            name: 'localink.capability_invoke',
            arguments: {
              capabilityId: descriptor.id,
              input: { scenario: 'png', bytes },
            },
          });
          assert.equal(result.isError, false, `image bytes: ${bytes}`);
          const block = result.content.find((item) => item.type === 'image');
          assert.ok(block && 'data' in block);
          assert.equal(Buffer.from(block.data, 'base64').length, bytes);
          assert.equal(
            JSON.stringify(result.structuredContent).includes(block.data),
            false,
          );
        }
      } finally {
        await client.close();
      }
    });
    await withProvider(async (stateRoot) => {
      const result = await invoke(stateRoot, 'image_read', 'png', 1_200_000);
      assert.equal(
        result.content.some((block) => block.type === 'image'),
        false,
      );
    }, false);
  },
);
