import { McpServer } from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'rich-image-fixture', version: '1.0.0' });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const jpeg = Buffer.from([255, 216, 255, 224, 0, 0, 0, 0]);

function register(
  name: string,
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint?: boolean;
  },
) {
  server.registerTool(
    name,
    {
      inputSchema: z.strictObject({
        scenario: z.string(),
        bytes: z.number().int().min(12).max(5_000_100).optional(),
      }),
      ...(annotations === undefined ? {} : { annotations }),
    },
    ({ scenario, bytes }) => {
      if (scenario === 'plain') {
        return {
          content: [{ type: 'text', text: 'ordinary result' }],
          structuredContent: { value: 'ordinary result' },
        };
      }
      const isJpeg = scenario === 'jpeg' || scenario === 'mismatch';
      const header = isJpeg ? jpeg : png;
      const body = Buffer.alloc(Math.max(header.length, bytes ?? 12));
      header.copy(body);
      const data = body.toString('base64');
      const image = {
        type: 'image' as const,
        data: scenario === 'invalid-base64' ? 'not-valid***' : data,
        mimeType:
          scenario === 'mime-denied'
            ? 'image/gif'
            : scenario === 'mismatch'
              ? 'image/png'
              : isJpeg
                ? 'image/jpeg'
                : 'image/png',
      };
      const content: unknown[] = [
        {
          type: 'text',
          text:
            scenario === 'metadata-large'
              ? 'bounded metadata '.repeat(1800)
              : scenario === 'duplicate-text'
                ? data
                : JSON.stringify({
                    rootId: 'fixture',
                    relativePath: 'synthetic.png',
                  }),
        },
        image,
      ];
      if (scenario === 'audio-only') content.splice(1, 1);
      if (scenario === 'two-images') content.push(image);
      if (scenario === 'audio' || scenario === 'audio-only')
        content.push({ type: 'audio', data, mimeType: 'audio/wav' });
      if (scenario === 'resource')
        content.push({
          type: 'resource',
          resource: { uri: 'fixture:test', text: data },
        });
      if (scenario === 'resource-link')
        content.push({
          type: 'resource_link',
          uri: 'fixture:test',
          name: 'test',
        });
      const result = {
        content,
        structuredContent: {
          rootId: 'fixture',
          relativePath: 'synthetic.png',
          ...(scenario === 'duplicate' ? { data } : {}),
        },
        ...(scenario === 'provider-error' ? { isError: true } : {}),
      };
      return result as never;
    },
  );
}

register('image_read', { readOnlyHint: true, destructiveHint: false });
register('image_raw');
register('image_write', { readOnlyHint: false, destructiveHint: false });
register('image_open', {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
});
register('image_destroy', { readOnlyHint: true, destructiveHint: true });

const handle = serveStdio(() => server, {
  transport: new StdioServerTransport(process.stdin, process.stdout),
});
process.stdin.once('end', () => void handle.close());
