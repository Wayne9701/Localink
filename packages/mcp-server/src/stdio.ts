import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { createFixtureRuntime } from './fixture-runtime.js';
import { createPublicServer } from './server.js';
import { logTransportFailure } from './errors.js';

async function main() {
  const runtime = await createFixtureRuntime();
  const handle = serveStdio(() => createPublicServer(runtime), {
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 64 * 1024,
    }),
    onerror: logTransportFailure,
  });
  const stop = () => {
    void handle.close().catch(logTransportFailure);
  };
  process.stdin.once('end', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(() => {
  logTransportFailure();
  process.exitCode = 1;
});
