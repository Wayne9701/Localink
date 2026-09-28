import { spawn } from 'node:child_process';
import { AgentError } from './types.js';

const MAX_ENUMERATION_BYTES = 2 * 1024 * 1024;
const MAX_NAME_BYTES = 128;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export const CAPABILITY_PROFILE = 'workspace-dev-v1' as const;

export const CAPABILITY_FEATURE_OVERRIDES = [
  'features.plugins=false',
  'features.apps=false',
  'features.computer_use=false',
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.browser_use_full_cdp_access=false',
  'features.in_app_browser=false',
] as const;

export interface CapabilityProjection {
  readonly profile: typeof CAPABILITY_PROFILE;
  readonly ambientServerNames: readonly string[];
  readonly launchArgs: readonly string[];
}

/**
 * Uses the official names-only first column of `codex mcp list`. The parser
 * deliberately discards every byte after the first column of each line, so
 * commands, arguments, environment values, URLs and auth material are never
 * retained, returned, logged or persisted by Localink.
 */
export async function projectWorkspaceDevCapabilities(
  executable: string,
  environment?: NodeJS.ProcessEnv,
): Promise<CapabilityProjection> {
  const enumerationArgs = [
    ...CAPABILITY_FEATURE_OVERRIDES.flatMap((value) => ['-c', value]),
    'mcp',
    'list',
  ];
  const names = await enumerateServerNames(
    executable,
    enumerationArgs,
    environment,
  );
  return {
    profile: CAPABILITY_PROFILE,
    ambientServerNames: names,
    launchArgs: [
      ...CAPABILITY_FEATURE_OVERRIDES.flatMap((value) => ['-c', value]),
      ...names.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
    ],
  };
}

async function enumerateServerNames(
  executable: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  return await new Promise<readonly string[]>((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(environment ? { env: environment } : {}),
    });
    const names = new Set<string>();
    let totalBytes = 0;
    let prefix = '';
    let discarding = false;
    let sawHeader = false;
    let invalidName = false;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new AgentError(
          'CAPABILITY_ISOLATION_UNAVAILABLE',
          'Codex MCP names-only enumeration failed.',
        ),
      );
    };
    const finishLine = () => {
      if (prefix === 'Name') sawHeader = true;
      else if (sawHeader && prefix) {
        if (SERVER_NAME.test(prefix)) names.add(prefix);
        else invalidName = true;
      }
      prefix = '';
      discarding = false;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > MAX_ENUMERATION_BYTES) {
        fail();
        return;
      }
      for (const character of chunk) {
        if (character === '\n') {
          finishLine();
          continue;
        }
        if (discarding) continue;
        if (/\s/.test(character)) {
          discarding = true;
          continue;
        }
        if (Buffer.byteLength(prefix + character) > MAX_NAME_BYTES) {
          discarding = true;
          prefix = '';
          continue;
        }
        prefix += character;
      }
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      if (prefix) finishLine();
      if (code !== 0 || !sawHeader || invalidName) {
        fail();
        return;
      }
      settled = true;
      resolve([...names].sort());
    });
  });
}
