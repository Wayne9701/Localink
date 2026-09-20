import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { logTransportFailure } from '../src/errors.js';
import { createFixtureRuntime } from '../src/fixture-runtime.js';
import { createPublicServer } from '../src/server.js';

async function main(): Promise<void> {
  const runtime = await createFixtureRuntime();
  const handle = serveStdio(
    () => createPublicServer(runtime, undefined, true),
    {
      transport: new StdioServerTransport(process.stdin, process.stdout, {
        maxBufferSize: 64 * 1024,
      }),
      onerror: logTransportFailure,
    },
  );
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
