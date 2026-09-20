import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { createLocalinkRuntime } from '@localink/runtime';
import { createPublicServer } from './server.js';
import { logTransportFailure } from './errors.js';

async function main() {
  const runtime = await createLocalinkRuntime();
  const handle = serveStdio(() => createPublicServer(runtime), {
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 64 * 1024,
    }),
    onerror: logTransportFailure,
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= handle
      .close()
      .finally(() => runtime.close())
      .catch(logTransportFailure);
  };
  process.stdin.once('end', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(() => {
  logTransportFailure();
  process.exitCode = 1;
});
