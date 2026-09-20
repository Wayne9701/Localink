import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import type { PublicRuntime } from './runtime.js';
import { createPublicServer } from './server.js';
import { logTransportFailure } from './errors.js';
import { assertResultLimit, RESULT_LIMITS } from './bounded-result.js';

export interface HttpListenerOptions {
  host?: '127.0.0.1' | '::1';
  port?: number;
  resultLimit?: number;
}

export interface HttpOptions extends HttpListenerOptions {
  runtime: PublicRuntime;
  testFixtureContext?: boolean;
}

export async function startHttpServer(options: HttpOptions) {
  assertResultLimit(options.resultLimit ?? RESULT_LIMITS.defaultBytes);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4318;
  if (
    !['127.0.0.1', '::1'].includes(host) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new RangeError('Invalid loopback host or port.');
  }
  const runtime = options.runtime;
  let adaptersCreated = 0;
  const handler = createMcpHandler(
    () => {
      adaptersCreated++;
      return createPublicServer(
        runtime,
        options.resultLimit,
        options.testFixtureContext ?? false,
      );
    },
    { legacy: 'reject', onerror: logTransportFailure },
  );
  const nodeHandler = toNodeHandler(handler, { onerror: logTransportFailure });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response))
      return;
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    // SDK's structural optional fields omit explicit undefined; Node's types
    // include it. Parsed IncomingMessage supplies method/url at this boundary.
    void nodeHandler(request as NodeIncomingMessageLike, response).catch(() => {
      logTransportFailure();
      if (!response.headersSent)
        response.writeHead(500, { 'content-type': 'application/json' });
      if (!response.writableEnded)
        response.end(
          '{"error":{"layer":"transport","code":"TRANSPORT_FAILURE"}}',
        );
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Listener unavailable.');
  let closing: Promise<void> | undefined;
  return {
    url: new URL(
      `http://${host === '::1' ? '[::1]' : host}:${address.port}/mcp`,
    ),
    address,
    get adaptersCreated() {
      return adaptersCreated;
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        try {
          await handler.close();
        } finally {
          server.closeAllConnections();
        }
        await closed;
      })();
      return closing;
    },
  };
}

export function httpOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): HttpListenerOptions {
  const host = env.LOCALINK_MCP_HOST ?? '127.0.0.1';
  const rawPort = env.LOCALINK_MCP_PORT ?? '4318';
  if (
    (host !== '127.0.0.1' && host !== '::1') ||
    !/^\d{1,5}$/u.test(rawPort) ||
    Number(rawPort) > 65535
  ) {
    throw new RangeError('Invalid loopback host or port.');
  }
  return { host, port: Number(rawPort) };
}
