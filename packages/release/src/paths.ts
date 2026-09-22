import { homedir } from 'node:os';
import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { ReleaseError } from './errors.js';
import type { ReleaseLayout } from './types.js';

export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

export function assertRelativeArtifactPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..') ||
    path.posix.normalize(value) !== value
  ) {
    throw new ReleaseError(
      'RELEASE_PATH_UNSAFE',
      'Release artifact contains an unsafe relative path.',
    );
  }
  return value;
}

async function rejectSymlinkIfPresent(candidate: string): Promise<void> {
  try {
    const status = await lstat(candidate);
    if (status.isSymbolicLink()) {
      throw new ReleaseError(
        'RELEASE_PATH_UNSAFE',
        'Managed install directories must not be symbolic links.',
      );
    }
    if (!status.isDirectory()) {
      throw new ReleaseError(
        'RELEASE_PATH_UNSAFE',
        'Managed install path must be a directory.',
      );
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return;
    throw error;
  }
}

export async function prepareReleaseLayout(
  rootInput: string,
  options: { readonly allowFixtureRoot?: boolean } = {},
): Promise<ReleaseLayout> {
  if (!path.isAbsolute(rootInput) || rootInput.includes('\0')) {
    throw new ReleaseError(
      'RELEASE_PATH_UNSAFE',
      'Release root must be absolute.',
    );
  }
  const root = path.normalize(rootInput);
  if (
    options.allowFixtureRoot !== true &&
    root !== path.join(homedir(), '.localink')
  ) {
    throw new ReleaseError(
      'RELEASE_PATH_UNSAFE',
      'Production releases are restricted to the Localink-owned root.',
    );
  }
  const appRoot = path.join(root, 'app');
  const releasesRoot = path.join(appRoot, 'releases');
  const stagingRoot = path.join(appRoot, 'staging');
  const launcherPath = path.join(root, 'bin', 'localink');
  for (const candidate of [
    root,
    appRoot,
    releasesRoot,
    stagingRoot,
    path.dirname(launcherPath),
  ]) {
    await rejectSymlinkIfPresent(candidate);
  }
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  const managed = [appRoot, releasesRoot, stagingRoot, launcherPath];
  if (
    managed.some(
      (candidate) => candidate !== appRoot && !isWithin(root, candidate),
    )
  ) {
    throw new ReleaseError(
      'RELEASE_PATH_UNSAFE',
      'Release layout escaped the Localink-owned root.',
    );
  }
  return {
    root,
    appRoot,
    releasesRoot,
    stagingRoot,
    currentPointer: path.join(appRoot, 'current'),
    previousPointer: path.join(appRoot, 'previous'),
    launcherPath,
  };
}

export function validateReleaseId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u.test(value)) {
    throw new ReleaseError('RELEASE_INPUT_INVALID', 'Release id is invalid.');
  }
  return value;
}
