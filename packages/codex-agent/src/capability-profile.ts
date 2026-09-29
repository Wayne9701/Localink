import { spawn } from 'node:child_process';
import { AgentError } from './types.js';

const MAX_ENUMERATION_BYTES = 2 * 1024 * 1024;
const MAX_NAME_BYTES = 128;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export const CAPABILITY_PROFILE = 'codex-native-v1' as const;
export const LEGACY_CAPABILITY_PROFILE = 'workspace-dev-v1' as const;

/**
 * These servers can recursively start/supervise another Codex execution chain.
 * Ordinary Localink Native Agents inherit Codex's effective capability config
 * except for this narrow recursion/conflict denylist.
 */
export const RECURSION_DENYLIST = new Set<string>(['engineering-bridge']);

export interface CapabilityProjection {
  readonly profile: typeof CAPABILITY_PROFILE;
  readonly configuredServerNames: readonly string[];
  readonly deniedServerNames: readonly string[];
  readonly launchArgs: readonly string[];
}

/**
 * Read only the first names column from `codex mcp list`.
 *
 * Localink intentionally discards everything after the first whitespace on
 * every row, so commands, arguments, URLs, environment values and auth material
 * are never retained, returned, logged or persisted.
 *
 * All normal Codex capabilities are inherited from the user's/project's Codex
 * configuration. Localink emits launch overrides only for configured servers
 * that match the recursion/conflict denylist.
 */
export async function projectCodexNativeCapabilities(
  executable: string,
  environment?: NodeJS.ProcessEnv,
): Promise<CapabilityProjection> {
  const names = await enumerateServerNames(
    executable,
    ['mcp', 'list'],
    environment,
  );
  const denied = names.filter((name) => RECURSION_DENYLIST.has(name));
  return {
    profile: CAPABILITY_PROFILE,
    configuredServerNames: names,
    deniedServerNames: denied,
    launchArgs: denied.flatMap((name) => [
      '-c',
      `mcp_servers.${name}.enabled=false`,
    ]),
  };
}

// Backward-compatible symbol for older callers/tests while 04C rolls out.
export const projectWorkspaceDevCapabilities = projectCodexNativeCapabilities;

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
          invalidName = true;
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
