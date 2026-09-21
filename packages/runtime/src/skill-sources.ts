import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SkillRegistry } from '@localink/core';
import { CONTRACT_VERSION_V1, LocalinkError } from '@localink/sdk';

export const SKILL_SOURCE_SCHEMA_VERSION = 1;
export const SKILL_SOURCE_LIMITS = {
  sources: 20,
  skillsPerSource: 500,
  skillBytes: 1024 * 1024,
  metadataBytes: 32 * 1024,
} as const;

const SAFE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;

export interface SkillSource {
  readonly id: string;
  readonly root: string;
  readonly enabled: boolean;
}

export interface SkillSourcesConfig {
  readonly version: typeof SKILL_SOURCE_SCHEMA_VERSION;
  readonly sources: readonly unknown[];
}

export interface SkillSourceStoreLike {
  read(): Promise<SkillSourcesConfig | undefined>;
  write(value: SkillSourcesConfig): Promise<SkillSourcesConfig>;
}

export interface SkillSourceStatus {
  readonly id: string;
  readonly state: 'ready' | 'disabled' | 'degraded';
  readonly loadedSkills: number;
  readonly skippedSkills: number;
  readonly reasonCode?: string;
}

export interface SkillSourceLoadSummary {
  readonly configuredSources: number;
  readonly loadedSkills: number;
  readonly degradedSources: number;
  readonly sources: readonly SkillSourceStatus[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validateSkillSourcesConfig(value: unknown): SkillSourcesConfig {
  if (
    !isRecord(value) ||
    !strictKeys(value, ['version', 'sources']) ||
    value.version !== SKILL_SOURCE_SCHEMA_VERSION ||
    !Array.isArray(value.sources) ||
    value.sources.length > SKILL_SOURCE_LIMITS.sources
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Skill source config must use bounded schema version 1.',
    );
  }
  return {
    version: SKILL_SOURCE_SCHEMA_VERSION,
    sources: structuredClone(value.sources),
  };
}

export function parseSkillSource(value: unknown): SkillSource {
  if (
    !isRecord(value) ||
    !strictKeys(value, ['id', 'root', 'enabled']) ||
    typeof value.id !== 'string' ||
    !SAFE_ID.test(value.id) ||
    typeof value.root !== 'string' ||
    !path.isAbsolute(value.root) ||
    value.root.includes('\0') ||
    typeof value.enabled !== 'boolean'
  ) {
    throw new LocalinkError(
      'CONFIG_INVALID',
      'Skill source contains invalid fields.',
    );
  }
  return {
    id: value.id,
    root: path.resolve(value.root),
    enabled: value.enabled,
  };
}

export function validSkillSources(config?: SkillSourcesConfig): SkillSource[] {
  const sources: SkillSource[] = [];
  const seen = new Set<string>();
  for (const item of config?.sources ?? []) {
    try {
      const source = parseSkillSource(item);
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      sources.push(source);
    } catch {
      // Invalid entries are isolated and reported by the loader summary.
    }
  }
  return sources;
}

function safeSegment(value: string): string {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return /^[a-z]/u.test(normalized)
    ? normalized
    : `skill-${normalized || 'item'}`;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function metadata(
  content: string,
  fallback: string,
): {
  title: string;
  description: string;
} {
  let title = fallback;
  let description = '';
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const prefix = content.slice(0, SKILL_SOURCE_LIMITS.metadataBytes);
    const closing = prefix.match(/\r?\n---\r?\n/u);
    if (closing?.index === undefined) {
      throw new LocalinkError(
        'CONTRACT_INVALID',
        'Skill frontmatter is not bounded or terminated.',
      );
    }
    const frontmatter = prefix.slice(prefix.indexOf('\n') + 1, closing.index);
    for (const line of frontmatter.split(/\r?\n/u)) {
      const match = line.match(/^(name|description):\s*(.*?)\s*$/u);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      const parsed = match[2].replace(/^(['"])(.*)\1$/u, '$2').trim();
      if (match[1] === 'name' && parsed.length > 0) title = parsed;
      if (match[1] === 'description' && parsed.length > 0) description = parsed;
    }
  }
  if (description.length === 0) {
    description =
      content
        .replace(/^---[\s\S]*?\r?\n---\r?\n/u, '')
        .split(/\r?\n/u)
        .map((line) => line.replace(/^#+\s*/u, '').trim())
        .find((line) => line.length > 0)
        ?.slice(0, 512) ?? `Shared Skill ${fallback}`;
  }
  return {
    title: title.slice(0, 256),
    description: description.slice(0, 1024),
  };
}

async function loadSource(
  source: SkillSource,
  registry: SkillRegistry,
): Promise<SkillSourceStatus> {
  if (!source.enabled) {
    return {
      id: source.id,
      state: 'disabled',
      loadedSkills: 0,
      skippedSkills: 0,
    };
  }
  let loadedSkills = 0;
  let skippedSkills = 0;
  try {
    const sourceInfo = await lstat(source.root);
    if (!sourceInfo.isDirectory()) throw new Error('not-directory');
    const canonicalRoot = await realpath(source.root);
    const entries = [];
    const directoryHandle = await opendir(canonicalRoot);
    for await (const entry of directoryHandle) {
      entries.push(entry);
      if (entries.length > SKILL_SOURCE_LIMITS.skillsPerSource) break;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length > SKILL_SOURCE_LIMITS.skillsPerSource) {
      skippedSkills++;
      entries.length = SKILL_SOURCE_LIMITS.skillsPerSource;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const directory = path.join(canonicalRoot, entry.name);
        const canonicalDirectory = await realpath(directory);
        if (!inside(canonicalRoot, canonicalDirectory))
          throw new Error('escape');
        const skillPath = path.join(canonicalDirectory, 'SKILL.md');
        const skillInfo = await lstat(skillPath);
        if (!skillInfo.isFile() || skillInfo.isSymbolicLink())
          throw new Error('not-file');
        const canonicalSkillPath = await realpath(skillPath);
        if (!inside(canonicalRoot, canonicalSkillPath))
          throw new Error('escape');
        const size = (await stat(canonicalSkillPath)).size;
        if (size > SKILL_SOURCE_LIMITS.skillBytes) throw new Error('oversized');
        const content = await readFile(canonicalSkillPath, 'utf8');
        if (content.includes('\0')) throw new Error('malformed');
        const names = metadata(content, entry.name);
        registry.register({
          manifest: {
            contractVersion: CONTRACT_VERSION_V1,
            id: `skill.${source.id}.${safeSegment(entry.name)}`,
            version: '1.0.0-external-source-v1',
            title: names.title,
            description: names.description,
            entry: 'SKILL.md',
            tags: ['shared', `source-${source.id}`],
          },
          location: `source:${source.id}/${entry.name}/SKILL.md`,
          content,
        });
        loadedSkills++;
      } catch {
        skippedSkills++;
      }
    }
    return {
      id: source.id,
      state: skippedSkills === 0 ? 'ready' : 'degraded',
      loadedSkills,
      skippedSkills,
      ...(skippedSkills === 0 ? {} : { reasonCode: 'SKILL_ITEMS_SKIPPED' }),
    };
  } catch {
    return {
      id: source.id,
      state: 'degraded',
      loadedSkills,
      skippedSkills,
      reasonCode: 'SKILL_SOURCE_UNAVAILABLE',
    };
  }
}

export async function loadSkillSources(
  config: SkillSourcesConfig | undefined,
  registry: SkillRegistry,
): Promise<SkillSourceLoadSummary> {
  const parsed = validSkillSources(config);
  const invalidEntries = (config?.sources.length ?? 0) - parsed.length;
  const statuses: SkillSourceStatus[] = [];
  if (invalidEntries > 0) {
    statuses.push({
      id: 'invalid-config-entry',
      state: 'degraded',
      loadedSkills: 0,
      skippedSkills: invalidEntries,
      reasonCode: 'SKILL_SOURCE_CONFIG_INVALID',
    });
  }
  for (const source of parsed)
    statuses.push(await loadSource(source, registry));
  return {
    configuredSources: config?.sources.length ?? 0,
    loadedSkills: statuses.reduce(
      (count, item) => count + item.loadedSkills,
      0,
    ),
    degradedSources: statuses.filter((item) => item.state === 'degraded')
      .length,
    sources: statuses,
  };
}

export async function addSkillSource(
  store: SkillSourceStoreLike,
  id: string,
  root: string,
): Promise<SkillSource> {
  const source = parseSkillSource({ id, root, enabled: true });
  const config = (await store.read()) ?? {
    version: SKILL_SOURCE_SCHEMA_VERSION,
    sources: [],
  };
  const sources = validSkillSources(config);
  if (sources.some((item) => item.id === source.id))
    throw new LocalinkError('ALREADY_EXISTS', 'Skill source already exists.');
  if (sources.length >= SKILL_SOURCE_LIMITS.sources)
    throw new LocalinkError(
      'SIZE_LIMIT_EXCEEDED',
      'Skill source limit reached.',
    );
  await store.write({
    version: SKILL_SOURCE_SCHEMA_VERSION,
    sources: [...sources, source],
  });
  return source;
}

export async function removeSkillSource(
  store: SkillSourceStoreLike,
  id: string,
): Promise<SkillSource> {
  const config = (await store.read()) ?? {
    version: SKILL_SOURCE_SCHEMA_VERSION,
    sources: [],
  };
  const sources = validSkillSources(config);
  const source = sources.find((item) => item.id === id);
  if (source === undefined)
    throw new LocalinkError('NOT_FOUND', 'Skill source was not found.');
  await store.write({
    version: SKILL_SOURCE_SCHEMA_VERSION,
    sources: sources.filter((item) => item.id !== id),
  });
  return source;
}
