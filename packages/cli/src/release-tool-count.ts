import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReleaseReadinessError } from './release-readiness.js';

const MAX_PUBLIC_TOOL_COUNT = 256;

export async function readReleaseToolCount(
  releasePath: string,
): Promise<number> {
  const modulePath = path.join(
    releasePath,
    'payload',
    'node_modules',
    '@localink',
    'mcp-server',
    'dist',
    'src',
    'tool-definitions.js',
  );
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(modulePath).href);
  } catch {
    throw new ReleaseReadinessError(
      'LOCAL_MCP_FAILED',
      'Release public tool inventory could not be loaded safely.',
    );
  }
  const names =
    typeof imported === 'object' &&
    imported !== null &&
    'TOOL_NAMES' in imported
      ? (imported as { TOOL_NAMES?: unknown }).TOOL_NAMES
      : undefined;
  if (
    !Array.isArray(names) ||
    names.length < 1 ||
    names.length > MAX_PUBLIC_TOOL_COUNT ||
    !names.every((name) => typeof name === 'string' && name.length > 0) ||
    new Set(names).size !== names.length
  ) {
    throw new ReleaseReadinessError(
      'LOCAL_MCP_FAILED',
      'Release public tool inventory is invalid.',
    );
  }
  return names.length;
}
