import { createLocalinkRuntime } from '@localink/runtime';
import { startHttpServer, httpOptionsFromEnv } from './http.js';
import { logTransportFailure } from './errors.js';

async function main() {
  const runtime = await createLocalinkRuntime();
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  try {
    server = await startHttpServer({
      ...httpOptionsFromEnv(process.env),
      runtime,
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  process.stderr.write(`Localink MCP listening at ${server.url.href}\n`);
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= server
      .close()
      .finally(() => runtime.close())
      .catch(logTransportFailure);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(() => {
  logTransportFailure();
  process.exitCode = 1;
});
