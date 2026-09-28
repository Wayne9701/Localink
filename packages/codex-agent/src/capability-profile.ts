import { spawn } from 'node:child_process';
import { ManagedAppServerClient } from './app-server-client.js';
import { AgentError } from './types.js';

const MAX_ENUMERATION_BYTES = 2 * 1024 * 1024;
const MAX_NAME_BYTES = 128;
const MAX_INSTALLED_APPS = 128;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const APP_ID = /^[A-Za-z0-9_-]+$/;

export const CAPABILITY_PROFILE = 'codex-native-v1' as const;
export const LEGACY_CAPABILITY_PROFILE = 'workspace-dev-v1' as const;

/**
 * Direct MCP servers that would recursively start/supervise another Codex chain.
 */
export const RECURSION_MCP_DENYLIST = new Set<string>(['engineering-bridge']);

/**
 * Installed Apps that are themselves local execution/control planes.
 *
 * They are intentionally excluded from a Localink-launched Codex Agent so the
 * task cannot escape its Localink Workspace authority by re-entering Localink,
 * Codexless, DevSpace, or Engineering Bridge. Normal business/data Apps remain
 * inherited from Codex unchanged.
 */
export const RECURSION_APP_DENYLIST = new Set<string>([
  'engineering bridge',
  'localink',
  'codexless',
  'devspace',
]);

export interface InstalledCodexApp {
  readonly id: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly callable: boolean;
}

export interface CapabilityProjection {
  readonly profile: typeof CAPABILITY_PROFILE;
  readonly configuredServerNames: readonly string[];
  readonly deniedServerNames: readonly string[];
  readonly deniedAppNames: readonly string[];
  readonly launchArgs: readonly string[];
}

type InstalledAppsEnumerator = (
  executable: string,
  environment: NodeJS.ProcessEnv | undefined,
  launchArgs: readonly string[],
) => Promise<readonly InstalledCodexApp[]>;

/**
 * Ordinary Localink Native Agents inherit Codex's effective user/project
 * capability configuration. Localink emits launch overrides only for
 * recursion/conflict control planes.
 *
 * No MCP command, URL, environment value, token, or app credential is retained.
 */
export async function projectCodexNativeCapabilities(
  executable: string,
  environment?: NodeJS.ProcessEnv,
  installedAppsEnumerator: InstalledAppsEnumerator = enumerateInstalledApps,
): Promise<CapabilityProjection> {
  const names = await enumerateServerNames(
    executable,
    ['mcp', 'list'],
    environment,
  );
  const deniedServers = names.filter((name) =>
    RECURSION_MCP_DENYLIST.has(name),
  );
  const serverLaunchArgs = deniedServers.flatMap((name) => [
    '-c',
    `mcp_servers.${name}.enabled=false`,
  ]);

  const installedApps = await installedAppsEnumerator(
    executable,
    environment,
    serverLaunchArgs,
  );
  const deniedApps = installedApps
    .filter(
      (app) =>
        app.enabled &&
        RECURSION_APP_DENYLIST.has(app.runtimeName.trim().toLowerCase()),
    )
    .sort((left, right) => left.runtimeName.localeCompare(right.runtimeName));

  return {
    profile: CAPABILITY_PROFILE,
    configuredServerNames: names,
    deniedServerNames: deniedServers,
    deniedAppNames: deniedApps.map((app) => app.runtimeName),
    launchArgs: [
      ...serverLaunchArgs,
      ...deniedApps.flatMap((app) => ['-c', `apps.${app.id}.enabled=false`]),
    ],
  };
}

// Backward-compatible symbol for older callers/tests while 04C rolls out.
export const projectWorkspaceDevCapabilities = projectCodexNativeCapabilities;

async function enumerateInstalledApps(
  executable: string,
  environment: NodeJS.ProcessEnv | undefined,
  launchArgs: readonly string[],
): Promise<readonly InstalledCodexApp[]> {
  const client = new ManagedAppServerClient({
    executable,
    launchArgs,
    ...(environment ? { environment } : {}),
  });
  try {
    await client.start();
    const result = await client.request(
      'app/installed',
      { forceRefresh: false },
      30_000,
    );
    return parseInstalledApps(result);
  } catch (error) {
    throw new AgentError(
      'CAPABILITY_ISOLATION_UNAVAILABLE',
      `Codex installed-app enumeration failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

function parseInstalledApps(value: unknown): readonly InstalledCodexApp[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('apps' in value) ||
    !Array.isArray((value as { apps?: unknown }).apps)
  ) {
    throw new AgentError(
      'CAPABILITY_ISOLATION_UNAVAILABLE',
      'Codex installed-app response is invalid.',
    );
  }
  const rawApps = (value as { apps: unknown[] }).apps;
  if (rawApps.length > MAX_INSTALLED_APPS) {
    throw new AgentError(
      'CAPABILITY_ISOLATION_UNAVAILABLE',
      'Codex installed-app response exceeds the safety bound.',
    );
  }
  return rawApps.map((raw) => {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('id' in raw) ||
      !('runtimeName' in raw) ||
      !('enabled' in raw) ||
      !('callable' in raw)
    ) {
      throw new AgentError(
        'CAPABILITY_ISOLATION_UNAVAILABLE',
        'Codex installed-app entry is invalid.',
      );
    }
    const app = raw as Record<string, unknown>;
    if (
      typeof app.id !== 'string' ||
      !APP_ID.test(app.id) ||
      typeof app.runtimeName !== 'string' ||
      app.runtimeName.length < 1 ||
      app.runtimeName.length > MAX_NAME_BYTES ||
      typeof app.enabled !== 'boolean' ||
      typeof app.callable !== 'boolean'
    ) {
      throw new AgentError(
        'CAPABILITY_ISOLATION_UNAVAILABLE',
        'Codex installed-app entry is invalid.',
      );
    }
    return {
      id: app.id,
      runtimeName: app.runtimeName,
      enabled: app.enabled,
      callable: app.callable,
    };
  });
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
