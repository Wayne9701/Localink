import { writeFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

function createFixtureServer(): McpServer {
  const server = new McpServer({
    name: 'localink-m4-fixture',
    version: '1.0.0',
  });
  const register = (
    name: string,
    annotations:
      { readOnlyHint: boolean; destructiveHint: boolean } | undefined,
  ) => {
    server.registerTool(
      name,
      {
        title: `Fixture ${name}`,
        description: `Fixture tool ${name}`,
        inputSchema: z.strictObject({ value: z.string().optional() }),
        ...(annotations === undefined ? {} : { annotations }),
      },
      (input) => {
        if (input.value === 'fail') {
          process.exit(17);
        }
        const payload = {
          name,
          input,
          envKeys: Object.keys(process.env).sort(),
          ...(input.value === 'large'
            ? { rows: Array.from({ length: 5000 }, (_, index) => ({ index })) }
            : {}),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        };
      },
    );
  };
  register('fixture_read', { readOnlyHint: true, destructiveHint: false });
  register('fixture_write', { readOnlyHint: false, destructiveHint: false });
  register('fixture_destroy', { readOnlyHint: true, destructiveHint: true });
  register('fixture_unknown', undefined);
  return server;
}

const pidFile = process.argv[2];
if (pidFile !== undefined) await writeFile(pidFile, String(process.pid));

const handle = serveStdio(() => createFixtureServer(), {
  transport: new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 1024 * 1024,
  }),
});

process.stdin.once('end', () => void handle.close());
