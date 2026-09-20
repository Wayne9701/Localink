import { startHttpServer, httpOptionsFromEnv } from './http.js';
import { logTransportFailure } from './errors.js';

async function main() {
  const server = await startHttpServer(httpOptionsFromEnv(process.env));
  process.stderr.write(
    `Localink fixture MCP listening at ${server.url.href}\n`,
  );
  const stop = () => {
    void server.close().catch(logTransportFailure);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(() => {
  logTransportFailure();
  process.exitCode = 1;
});
