import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PROTOCOL_VERSION } from '../src/server.js';

export const stdioEntry = fileURLToPath(
  new URL('../src/stdio.js', import.meta.url),
);

export function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

export function at(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) value = object(value)[key];
  return value;
}

export function envelope(result: CallToolResult) {
  const block = result.content?.[0];
  assert.equal(block?.type, 'text');
  assert.ok(block && 'text' in block && typeof block.text === 'string');
  const parsed: unknown = JSON.parse(block.text);
  assert.deepEqual(result.structuredContent, parsed);
  return object(parsed);
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  return envelope(
    await client.callTool({ name: `localink.${name}`, arguments: args }),
  );
}

export async function invoke(
  client: Client,
  capabilityId: string,
  input: unknown = {},
  fixtureContext?: Record<string, unknown>,
) {
  return call(client, 'capability_invoke', {
    capabilityId,
    input,
    ...(fixtureContext === undefined ? {} : { fixtureContext }),
  });
}

export async function stdioClient(modern = false) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [stdioEntry],
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'localink-e2e', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } } : {},
  );
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const errors: Error[] = [];
  client.onerror = (error) => errors.push(error);
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }
  return {
    client,
    transport,
    errors,
    get stderr() {
      return stderr;
    },
  };
}

export async function httpClient(url: URL) {
  const headers: {
    sentSession: boolean;
    receivedSession: boolean;
    versions: string[];
  } = {
    sentSession: false,
    receivedSession: false,
    versions: [],
  };
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      headers.sentSession ||= request.headers.has('mcp-session-id');
      const version = request.headers.get('mcp-protocol-version');
      if (version) headers.versions.push(version);
      const response = await fetch(request);
      headers.receivedSession ||= response.headers.has('mcp-session-id');
      return response;
    },
  });
  const client = new Client(
    { name: 'localink-http-e2e', version: '1.0.0' },
    {
      versionNegotiation: { mode: { pin: PROTOCOL_VERSION } },
    },
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }
  return { client, transport, headers };
}
