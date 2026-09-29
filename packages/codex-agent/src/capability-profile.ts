import { spawn } from 'node:child_process';
import { ManagedAppServerClient } from './app-server-client.js';
import { AgentError } from './types.js';

const MAX_ENUMERATION_BYTES = 2 * 1024 * 1024;
const MAX_NAME_BYTES = 128;
const MAX_INSTALLED_APPS = 128;
const MAX_APP_READ_APPS = 100;
const MAX_APP_TOOLS = 1024;
const MAX_TOOL_NAME_BYTES = 256;
const MAX_TOOLS_OVERRIDE_BYTES = 256 * 1024;
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const APP_ID = /^[A-Za-z0-9_-]+$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export const CAPABILITY_PROFILE = 'codex-native-v1' as const;
export const LEGACY_CAPABILITY_PROFILE = 'workspace-dev-v1' as const;

/**
 * Direct MCP servers that would recursively start/supervise another Codex chain.
 */
export const RECURSION_MCP_DENYLIST = new Set<string>(['engineering-bridge']);

/**
 * Installed Apps that contain local execution/control-plane tools.
 *
 * 04C3 keeps the Apps enabled and restricts their tools instead of disabling
 * the whole App. Normal business/data Apps remain inherited unchanged.
 */
export const RECURSION_APP_DENYLIST = new Set<string>([
  'engineering bridge',
  'localink',
  'codexless',
  'devspace',
]);

const DEFAULT_DISABLED_APP_NAMES = new Set<string>([
  'engineering bridge',
  'localink',
  'devspace',
]);
const CODEXLESS_APP_NAME = 'codexless';

export interface InstalledCodexApp {
  readonly id: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly callable: boolean;
  readonly codexlessToolNames?: readonly string[];
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
  const restrictedApps = validateInstalledApps(installedApps)
    .filter(
      (app) =>
        app.enabled &&
        RECURSION_APP_DENYLIST.has(app.runtimeName.trim().toLowerCase()),
    )
    .sort(
      (left, right) =>
        left.runtimeName.localeCompare(right.runtimeName) ||
        left.id.localeCompare(right.id),
    );
  const appLaunchArgs = restrictedApps.flatMap((app) => {
    const runtimeName = app.runtimeName.trim().toLowerCase();
    if (runtimeName === CODEXLESS_APP_NAME) {
      return ['-c', codexlessToolsOverride(app)];
    }
    if (DEFAULT_DISABLED_APP_NAMES.has(runtimeName)) {
      return ['-c', `apps.${app.id}.default_tools_enabled=false`];
    }
    throw isolationError('Codex installed-app entry is invalid.');
  });

  return {
    profile: CAPABILITY_PROFILE,
    configuredServerNames: names,
    deniedServerNames: deniedServers,
    deniedAppNames: restrictedApps.map((app) => app.runtimeName),
    launchArgs: [...serverLaunchArgs, ...appLaunchArgs],
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
    const installedApps = parseInstalledApps(result);
    const codexlessApps = installedApps.filter(
      (app) =>
        app.enabled &&
        app.runtimeName.trim().toLowerCase() === CODEXLESS_APP_NAME,
    );
    if (codexlessApps.length === 0) return installedApps;
    if (codexlessApps.length > MAX_APP_READ_APPS) {
      throw isolationError('Codex app/read request exceeds the safety bound.');
    }
    const appReadResult = await client.request(
      'app/read',
      {
        appIds: codexlessApps.map((app) => app.id),
        includeTools: true,
      },
      30_000,
    );
    const toolNamesByApp = parseCodexlessToolNames(
      appReadResult,
      codexlessApps.map((app) => app.id),
    );
    return installedApps.map((app) => {
      const codexlessToolNames = toolNamesByApp.get(app.id);
      return codexlessToolNames === undefined
        ? app
        : { ...app, codexlessToolNames };
    });
  } catch {
    throw isolationError('Codex installed-app enumeration failed.');
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
    throw isolationError('Codex installed-app response is invalid.');
  }
  return validateInstalledApps((value as { apps: unknown[] }).apps);
}

function validateInstalledApps(value: unknown): readonly InstalledCodexApp[] {
  if (!Array.isArray(value)) {
    throw isolationError('Codex installed-app response is invalid.');
  }
  const rawApps = value;
  if (rawApps.length > MAX_INSTALLED_APPS) {
    throw isolationError(
      'Codex installed-app response exceeds the safety bound.',
    );
  }
  const seenIds = new Set<string>();
  return rawApps.map((raw) => {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('id' in raw) ||
      !('runtimeName' in raw) ||
      !('enabled' in raw) ||
      !('callable' in raw)
    ) {
      throw isolationError('Codex installed-app entry is invalid.');
    }
    const app = raw as Record<string, unknown>;
    if (
      typeof app.id !== 'string' ||
      !APP_ID.test(app.id) ||
      typeof app.runtimeName !== 'string' ||
      app.runtimeName.trim().length < 1 ||
      Buffer.byteLength(app.runtimeName) > MAX_NAME_BYTES ||
      typeof app.enabled !== 'boolean' ||
      typeof app.callable !== 'boolean' ||
      seenIds.has(app.id)
    ) {
      throw isolationError('Codex installed-app entry is invalid.');
    }
    seenIds.add(app.id);
    const runtimeName = app.runtimeName.trim().toLowerCase();
    let codexlessToolNames: readonly string[] | undefined;
    if ('codexlessToolNames' in app) {
      if (runtimeName !== CODEXLESS_APP_NAME) {
        throw isolationError('Codex installed-app entry is invalid.');
      }
      codexlessToolNames = parseToolNames(app.codexlessToolNames);
    }
    return {
      id: app.id,
      runtimeName: app.runtimeName,
      enabled: app.enabled,
      callable: app.callable,
      ...(codexlessToolNames === undefined ? {} : { codexlessToolNames }),
    };
  });
}

function parseCodexlessToolNames(
  value: unknown,
  expectedAppIds: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('apps' in value) ||
    !Array.isArray((value as { apps?: unknown }).apps) ||
    !('missingAppIds' in value) ||
    !Array.isArray((value as { missingAppIds?: unknown }).missingAppIds)
  ) {
    throw isolationError('Codex app/read response is invalid.');
  }
  const expected = new Set(expectedAppIds);
  const rawApps = (value as { apps: unknown[] }).apps;
  const missingAppIds = (value as { missingAppIds: unknown[] }).missingAppIds;
  if (
    rawApps.length > MAX_APP_READ_APPS ||
    missingAppIds.length > MAX_APP_READ_APPS ||
    missingAppIds.length !== 0
  ) {
    throw isolationError('Codex app/read response is invalid.');
  }
  const result = new Map<string, readonly string[]>();
  for (const raw of rawApps) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      !('id' in raw) ||
      !('toolSummaries' in raw)
    ) {
      throw isolationError('Codex app/read entry is invalid.');
    }
    const app = raw as Record<string, unknown>;
    if (
      typeof app.id !== 'string' ||
      !APP_ID.test(app.id) ||
      !expected.has(app.id) ||
      result.has(app.id)
    ) {
      throw isolationError('Codex app/read entry is invalid.');
    }
    if (!Array.isArray(app.toolSummaries)) {
      throw isolationError('Codex app/read tool metadata is invalid.');
    }
    result.set(
      app.id,
      parseToolNames(
        app.toolSummaries.map((summary) =>
          typeof summary === 'object' && summary !== null && 'name' in summary
            ? (summary as { name: unknown }).name
            : undefined,
        ),
      ),
    );
  }
  if (
    result.size !== expected.size ||
    expectedAppIds.some((id) => !result.has(id))
  ) {
    throw isolationError('Codex app/read response is incomplete.');
  }
  return result;
}

function parseToolNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_APP_TOOLS) {
    throw isolationError('Codex App tool metadata exceeds the safety bound.');
  }
  const seen = new Set<string>();
  for (const name of value) {
    if (
      typeof name !== 'string' ||
      Buffer.byteLength(name) < 1 ||
      Buffer.byteLength(name) > MAX_TOOL_NAME_BYTES ||
      !TOOL_NAME.test(name) ||
      seen.has(name)
    ) {
      throw isolationError('Codex App tool metadata is invalid.');
    }
    seen.add(name);
  }
  return [...seen].sort();
}

function codexlessToolsOverride(app: InstalledCodexApp): string {
  if (app.codexlessToolNames === undefined) {
    throw isolationError('Codexless tool metadata is unavailable.');
  }
  const deniedTools = app.codexlessToolNames.filter(isDeniedCodexlessTool);
  const entries = deniedTools.map(
    (name) => `${JSON.stringify(name)} = { enabled = false }`,
  );
  const override = `apps.${app.id}.tools={${entries.length > 0 ? ` ${entries.join(', ')} ` : ''}}`;
  if (Buffer.byteLength(override) > MAX_TOOLS_OVERRIDE_BYTES) {
    throw isolationError('Codexless tool override exceeds the safety bound.');
  }
  return override;
}

function isDeniedCodexlessTool(name: string): boolean {
  return (
    name.startsWith('codex.agent_') ||
    name.startsWith('localagent.') ||
    name === 'codex.command_exec' ||
    name === 'codex.precise_edit' ||
    name.startsWith('localfs.') ||
    name.startsWith('localgit.')
  );
}

function isolationError(message: string): AgentError {
  return new AgentError('CAPABILITY_ISOLATION_UNAVAILABLE', message);
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
