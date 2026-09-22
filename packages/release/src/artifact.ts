import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { ReleaseError } from './errors.js';
import {
  assertRelativeArtifactPath,
  isWithin,
  validateReleaseId,
} from './paths.js';
import {
  RELEASE_MANIFEST_SCHEMA,
  type BuildReleaseInput,
  type ReleaseManifest,
  type ReleasePayloadFile,
} from './types.js';

const LOCAL_WORKSPACES = [
  'packages/sdk',
  'packages/core',
  'packages/service',
  'packages/runtime',
  'packages/mcp-server',
  'packages/cli',
  'transports/openai-tunnel',
] as const;

const ENTRYPOINT = 'payload/node_modules/@localink/cli/dist/src/cli.js';

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function dependencyPath(nodeModules: string, name: string): string {
  return path.join(nodeModules, ...name.split('/'));
}

function safeDestination(root: string, relative: string): string {
  const validated = assertRelativeArtifactPath(relative);
  const destination = path.join(root, ...validated.split('/'));
  if (!isWithin(root, destination)) {
    throw new ReleaseError(
      'RELEASE_PATH_UNSAFE',
      'Release path escaped its root.',
    );
  }
  return destination;
}

async function copyRegularTree(
  source: string,
  destination: string,
  options: { readonly skipNodeModules?: boolean } = {},
): Promise<void> {
  const sourceStatus = await lstat(source);
  if (
    sourceStatus.isSymbolicLink() ||
    (!sourceStatus.isDirectory() && !sourceStatus.isFile())
  ) {
    throw new ReleaseError(
      'RELEASE_PATH_UNSAFE',
      'Release payload may contain only regular files and directories.',
    );
  }
  if (sourceStatus.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const contents = await readFile(source);
    await writeFile(destination, contents, {
      mode: sourceStatus.mode & 0o111 ? 0o555 : 0o444,
    });
    return;
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of (await readdir(source)).sort()) {
    if (options.skipNodeModules === true && name === 'node_modules') continue;
    await copyRegularTree(
      path.join(source, name),
      path.join(destination, name),
      options,
    );
  }
}

interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

async function readPackageJson(filename: string): Promise<PackageJson> {
  return JSON.parse(await readFile(filename, 'utf8')) as PackageJson;
}

function dependencyNames(manifest: PackageJson): readonly string[] {
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
  ].filter((name) => !name.startsWith('@localink/'));
}

async function collectProductionDependencies(
  sourceRoot: string,
): Promise<readonly string[]> {
  const pending: string[] = [];
  for (const workspace of LOCAL_WORKSPACES) {
    pending.push(
      ...dependencyNames(
        await readPackageJson(path.join(sourceRoot, workspace, 'package.json')),
      ),
    );
  }
  const collected = new Set<string>();
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (collected.has(name)) continue;
    const packageRoot = dependencyPath(
      path.join(sourceRoot, 'node_modules'),
      name,
    );
    try {
      const manifest = await readPackageJson(
        path.join(packageRoot, 'package.json'),
      );
      collected.add(name);
      pending.push(...dependencyNames(manifest));
    } catch {
      throw new ReleaseError(
        'RELEASE_ARTIFACT_INVALID',
        `Production dependency ${name} is unavailable.`,
      );
    }
  }
  return [...collected].sort();
}

async function payloadFiles(
  payloadRoot: string,
): Promise<readonly ReleasePayloadFile[]> {
  const output: ReleasePayloadFile[] = [];
  async function visit(current: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      const absolute = path.join(current, name);
      const status = await lstat(absolute);
      if (
        status.isSymbolicLink() ||
        (!status.isDirectory() && !status.isFile())
      ) {
        throw new ReleaseError(
          'RELEASE_PATH_UNSAFE',
          'Release payload contains a link or special file.',
        );
      }
      if (status.isDirectory()) await visit(absolute);
      else {
        const contents = await readFile(absolute);
        output.push({
          path: path.posix.join(
            'payload',
            path.relative(payloadRoot, absolute).split(path.sep).join('/'),
          ),
          sha256: sha256(contents),
          size: contents.length,
          mode: status.mode & 0o111 ? 0o555 : 0o444,
        });
      }
    }
  }
  await visit(payloadRoot);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildReleaseArtifact(
  input: BuildReleaseInput,
): Promise<ReleaseManifest> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const artifactRoot = path.resolve(input.artifactRoot);
  validateReleaseId(input.releaseId);
  if (!/^[0-9a-f]{40}$/u.test(input.sourceCommit)) {
    throw new ReleaseError(
      'RELEASE_INPUT_INVALID',
      'Source commit must be a full Git SHA.',
    );
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(input.version)) {
    throw new ReleaseError(
      'RELEASE_INPUT_INVALID',
      'Release version is invalid.',
    );
  }
  try {
    const existing = await readdir(artifactRoot);
    if (existing.length > 0)
      throw new ReleaseError(
        'RELEASE_INPUT_INVALID',
        'Artifact destination must be empty.',
      );
  } catch (error) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ))
      throw error;
  }
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const payloadRoot = path.join(artifactRoot, 'payload');
  await mkdir(path.join(payloadRoot, 'node_modules'), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    path.join(payloadRoot, 'package.json'),
    '{"private":true,"type":"module"}\n',
    { mode: 0o444 },
  );
  for (const workspace of LOCAL_WORKSPACES) {
    const manifest = await readPackageJson(
      path.join(sourceRoot, workspace, 'package.json'),
    );
    if (manifest.name === undefined)
      throw new ReleaseError(
        'RELEASE_ARTIFACT_INVALID',
        'Workspace package name is missing.',
      );
    const destination = dependencyPath(
      path.join(payloadRoot, 'node_modules'),
      manifest.name,
    );
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await copyRegularTree(
      path.join(sourceRoot, workspace, 'package.json'),
      path.join(destination, 'package.json'),
    );
    await copyRegularTree(
      path.join(sourceRoot, workspace, 'dist', 'src'),
      path.join(destination, 'dist', 'src'),
    );
  }
  for (const dependency of await collectProductionDependencies(sourceRoot)) {
    await copyRegularTree(
      dependencyPath(path.join(sourceRoot, 'node_modules'), dependency),
      dependencyPath(path.join(payloadRoot, 'node_modules'), dependency),
      { skipNodeModules: true },
    );
  }
  const files = await payloadFiles(payloadRoot);
  if (!files.some((item) => item.path === ENTRYPOINT)) {
    throw new ReleaseError(
      'RELEASE_ARTIFACT_INVALID',
      'Release entrypoint is missing.',
    );
  }
  const builtAt = input.builtAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(builtAt)))
    throw new ReleaseError(
      'RELEASE_INPUT_INVALID',
      'Build timestamp is invalid.',
    );
  const manifest: ReleaseManifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA,
    product: 'localink',
    version: input.version,
    releaseId: input.releaseId,
    sourceCommit: input.sourceCommit,
    builtAt,
    platform: process.platform,
    arch: process.arch,
    requiredNodeMajor: 22,
    dependencyMode: 'packaged-production',
    requiredTunnelClient: '0.0.14',
    entrypoint: ENTRYPOINT,
    files,
  };
  await writeFile(
    path.join(artifactRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o444 },
  );
  return validateReleaseArtifact(artifactRoot);
}

function parseManifest(value: unknown): ReleaseManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReleaseError(
      'RELEASE_ARTIFACT_INVALID',
      'Release manifest must be an object.',
    );
  }
  const manifest = value as Partial<ReleaseManifest>;
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA ||
    manifest.product !== 'localink' ||
    typeof manifest.version !== 'string' ||
    typeof manifest.releaseId !== 'string' ||
    typeof manifest.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit) ||
    typeof manifest.builtAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.builtAt)) ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.requiredNodeMajor !== 22 ||
    manifest.dependencyMode !== 'packaged-production' ||
    manifest.requiredTunnelClient !== '0.0.14' ||
    manifest.entrypoint !== ENTRYPOINT ||
    !Array.isArray(manifest.files)
  )
    throw new ReleaseError(
      'RELEASE_ARTIFACT_INVALID',
      'Release manifest contract is invalid.',
    );
  validateReleaseId(manifest.releaseId);
  if (
    Number(process.versions.node.split('.')[0]) !== manifest.requiredNodeMajor
  ) {
    throw new ReleaseError(
      'RELEASE_ARTIFACT_INVALID',
      'Release requires a different Node major.',
    );
  }
  return manifest as ReleaseManifest;
}

async function listArtifactFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    const currentStatus = await lstat(current);
    if (currentStatus.isSymbolicLink() || !currentStatus.isDirectory()) {
      throw new ReleaseError(
        'RELEASE_PATH_UNSAFE',
        'Artifact root and directories must not be symbolic links.',
      );
    }
    for (const name of (await readdir(current)).sort()) {
      const absolute = path.join(current, name);
      const status = await lstat(absolute);
      if (
        status.isSymbolicLink() ||
        (!status.isDirectory() && !status.isFile())
      ) {
        throw new ReleaseError(
          'RELEASE_PATH_UNSAFE',
          'Artifact contains a link or special file.',
        );
      }
      if (status.isDirectory()) await visit(absolute);
      else files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  await visit(root);
  return files.sort();
}

export async function validateReleaseArtifact(
  artifactRootInput: string,
): Promise<ReleaseManifest> {
  const artifactRoot = path.resolve(artifactRootInput);
  let manifest: ReleaseManifest;
  try {
    manifest = parseManifest(
      JSON.parse(
        await readFile(path.join(artifactRoot, 'manifest.json'), 'utf8'),
      ) as unknown,
    );
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError(
      'RELEASE_ARTIFACT_INVALID',
      'Release manifest is unreadable.',
    );
  }
  const expected = new Set<string>(['manifest.json']);
  const seen = new Set<string>();
  for (const item of manifest.files) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.path !== 'string' ||
      typeof item.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(item.sha256) ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      (item.mode !== 0o444 && item.mode !== 0o555)
    )
      throw new ReleaseError(
        'RELEASE_ARTIFACT_INVALID',
        'Release file entry is invalid.',
      );
    assertRelativeArtifactPath(item.path);
    if (!item.path.startsWith('payload/') || seen.has(item.path)) {
      throw new ReleaseError(
        'RELEASE_ARTIFACT_INVALID',
        'Release file list is invalid or duplicated.',
      );
    }
    seen.add(item.path);
    expected.add(item.path);
    const absolute = safeDestination(artifactRoot, item.path);
    const status = await lstat(absolute).catch(() => undefined);
    if (status === undefined || !status.isFile() || status.isSymbolicLink()) {
      throw new ReleaseError(
        'RELEASE_ARTIFACT_INVALID',
        'Release payload file is missing or unsafe.',
      );
    }
    const contents = await readFile(absolute);
    if (contents.length !== item.size || sha256(contents) !== item.sha256) {
      throw new ReleaseError(
        'RELEASE_INTEGRITY_MISMATCH',
        'Release payload integrity check failed.',
      );
    }
  }
  const actual = await listArtifactFiles(artifactRoot);
  if (
    actual.length !== expected.size ||
    actual.some((item) => !expected.has(item))
  ) {
    throw new ReleaseError(
      'RELEASE_ARTIFACT_INVALID',
      'Release artifact contains unlisted files.',
    );
  }
  return manifest;
}

export async function stageReleaseArtifact(
  artifactRoot: string,
  stagingPath: string,
): Promise<ReleaseManifest> {
  await validateReleaseArtifact(artifactRoot);
  await mkdir(stagingPath, { recursive: false, mode: 0o700 });
  try {
    await copyRegularTree(
      path.join(artifactRoot, 'manifest.json'),
      path.join(stagingPath, 'manifest.json'),
    );
    await copyRegularTree(
      path.join(artifactRoot, 'payload'),
      path.join(stagingPath, 'payload'),
    );
    return await validateReleaseArtifact(stagingPath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

export async function makeReleaseImmutable(releasePath: string): Promise<void> {
  async function visit(current: string): Promise<void> {
    const status = await lstat(current);
    if (status.isDirectory()) {
      for (const name of await readdir(current))
        await visit(path.join(current, name));
      await chmod(current, 0o555);
    } else if (status.isFile())
      await chmod(current, status.mode & 0o111 ? 0o555 : 0o444);
    else
      throw new ReleaseError(
        'RELEASE_PATH_UNSAFE',
        'Installed release contains a link or special file.',
      );
  }
  await visit(releasePath);
}

export async function atomicWriteFile(
  destination: string,
  contents: string | Buffer,
  mode: number,
): Promise<void> {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}
