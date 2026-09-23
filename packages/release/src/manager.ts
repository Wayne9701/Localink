import { randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  atomicWriteFile,
  makeReleaseImmutable,
  stageReleaseArtifact,
  validateReleaseArtifact,
} from './artifact.js';
import { ReleaseError } from './errors.js';
import { prepareReleaseLayout, validateReleaseId } from './paths.js';
import type {
  ReleaseActivationHooks,
  ReleaseLayout,
  ReleaseManifest,
  ReleaseReceipt,
  ReleaseStatus,
} from './types.js';

interface PointerSnapshot {
  readonly current?: string;
  readonly previous?: string;
  readonly launcher?: {
    readonly contents: Buffer;
    readonly mode: number;
  };
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

function receipt(
  operation: ReleaseReceipt['operation'],
  status: ReleaseReceipt['status'],
  releaseId: string,
  options: {
    readonly previousReleaseId?: string | undefined;
    readonly pointerSwitched: boolean;
    readonly servicesVerified: boolean;
    readonly reasonCode?: string;
    readonly failureDetailCode?: string | undefined;
    readonly rollbackFailureDetailCode?: string | undefined;
  },
): ReleaseReceipt {
  return {
    operation,
    status,
    releaseId,
    ...(options.previousReleaseId === undefined
      ? {}
      : { previousReleaseId: options.previousReleaseId }),
    pointerSwitched: options.pointerSwitched,
    servicesVerified: options.servicesVerified,
    statePreserved: true,
    configPreserved: true,
    secretsPreserved: true,
    networkRequiredForRollback: false,
    ...(options.reasonCode === undefined
      ? {}
      : { reasonCode: options.reasonCode }),
    ...(options.failureDetailCode === undefined
      ? {}
      : { failureDetailCode: options.failureDetailCode }),
    ...(options.rollbackFailureDetailCode === undefined
      ? {}
      : { rollbackFailureDetailCode: options.rollbackFailureDetailCode }),
  };
}

async function pointerReleaseId(
  pointer: string,
  layout: ReleaseLayout,
): Promise<string | undefined> {
  let target: string;
  try {
    const status = await lstat(pointer);
    if (!status.isSymbolicLink()) {
      throw new ReleaseError(
        'RELEASE_PATH_UNSAFE',
        'Release pointer is not a symbolic link.',
      );
    }
    target = await readlink(pointer);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined;
    throw error;
  }
  const match = /^releases\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,95})$/u.exec(target);
  if (match?.[1] === undefined) {
    throw new ReleaseError(
      'RELEASE_PATH_UNSAFE',
      'Release pointer target is unsafe.',
    );
  }
  const releaseId = validateReleaseId(match[1]);
  const targetPath = path.join(layout.releasesRoot, releaseId);
  const status = await lstat(targetPath).catch(() => undefined);
  if (
    status === undefined ||
    !status.isDirectory() ||
    status.isSymbolicLink()
  ) {
    throw new ReleaseError(
      'RELEASE_NOT_FOUND',
      'Release pointer target is unavailable.',
    );
  }
  return releaseId;
}

async function atomicPointer(
  pointer: string,
  releaseId: string | undefined,
): Promise<void> {
  if (releaseId === undefined) {
    await rm(pointer, { force: true });
    return;
  }
  const temporary = `${pointer}.tmp-${randomUUID()}`;
  await symlink(`releases/${validateReleaseId(releaseId)}`, temporary);
  await rename(temporary, pointer);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeLauncher(layout: ReleaseLayout): Promise<void> {
  const entrypoint = path.join(
    layout.currentPointer,
    'payload',
    'node_modules',
    '@localink',
    'cli',
    'dist',
    'src',
    'cli.js',
  );
  const source = [
    '#!/bin/sh',
    `export LOCALINK_INSTALL_ROOT=${shellQuote(layout.currentPointer)}`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(entrypoint)} "$@"`,
    '',
  ].join('\n');
  await atomicWriteFile(layout.launcherPath, source, 0o700);
}

export class ReleaseManager {
  readonly #root: string;
  readonly #allowFixtureRoot: boolean;
  readonly #hooks: ReleaseActivationHooks;

  constructor(options: {
    readonly root: string;
    readonly allowFixtureRoot?: boolean;
    readonly hooks?: ReleaseActivationHooks;
  }) {
    this.#root = options.root;
    this.#allowFixtureRoot = options.allowFixtureRoot ?? false;
    this.#hooks = options.hooks ?? {};
  }

  async #layout(): Promise<ReleaseLayout> {
    return prepareReleaseLayout(this.#root, {
      allowFixtureRoot: this.#allowFixtureRoot,
    });
  }

  async status(): Promise<ReleaseStatus> {
    const layout = await this.#layout();
    const [current, previous] = await Promise.all([
      pointerReleaseId(layout.currentPointer, layout),
      pointerReleaseId(layout.previousPointer, layout),
    ]);
    const releases: string[] = [];
    for (const name of (await readdir(layout.releasesRoot)).sort()) {
      try {
        validateReleaseId(name);
        const releasePath = path.join(layout.releasesRoot, name);
        const status = await lstat(releasePath);
        if (!status.isDirectory() || status.isSymbolicLink()) continue;
        const manifest = await validateReleaseArtifact(releasePath);
        if (manifest.releaseId === name) releases.push(name);
      } catch {
        continue;
      }
    }
    return {
      ...(current === undefined ? {} : { current }),
      ...(previous === undefined ? {} : { previous }),
      releases,
    };
  }

  async #snapshot(layout: ReleaseLayout): Promise<PointerSnapshot> {
    const [current, previous] = await Promise.all([
      pointerReleaseId(layout.currentPointer, layout),
      pointerReleaseId(layout.previousPointer, layout),
    ]);
    let launcher: PointerSnapshot['launcher'];
    try {
      const status = await lstat(layout.launcherPath);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new ReleaseError(
          'RELEASE_PATH_UNSAFE',
          'Existing Localink launcher is unsafe.',
        );
      }
      launcher = {
        contents: await readFile(layout.launcherPath),
        mode: status.mode & 0o777,
      };
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    return {
      ...(current === undefined ? {} : { current }),
      ...(previous === undefined ? {} : { previous }),
      ...(launcher === undefined ? {} : { launcher }),
    };
  }

  async #restorePointers(
    layout: ReleaseLayout,
    snapshot: PointerSnapshot,
  ): Promise<void> {
    await atomicPointer(layout.currentPointer, snapshot.current);
    await atomicPointer(layout.previousPointer, snapshot.previous);
    if (snapshot.launcher === undefined) {
      await rm(layout.launcherPath, { force: true });
    } else {
      await atomicWriteFile(
        layout.launcherPath,
        snapshot.launcher.contents,
        snapshot.launcher.mode,
      );
    }
  }

  async #activate(layout: ReleaseLayout, releaseId: string): Promise<void> {
    const releasePath = path.join(layout.releasesRoot, releaseId);
    const manifest = await validateReleaseArtifact(releasePath);
    await this.#hooks.activate?.(releasePath, manifest);
  }

  async install(artifactRoot: string): Promise<ReleaseReceipt> {
    const layout = await this.#layout();
    const sourceManifest = await validateReleaseArtifact(artifactRoot);
    const releaseId = sourceManifest.releaseId;
    const destination = path.join(layout.releasesRoot, releaseId);
    const stagingPath = path.join(
      layout.stagingRoot,
      `${releaseId}-${randomUUID()}`,
    );
    let manifest: ReleaseManifest;
    const destinationStatus = await lstat(destination).catch(() => undefined);
    if (destinationStatus === undefined) {
      manifest = await stageReleaseArtifact(artifactRoot, stagingPath);
      await rename(stagingPath, destination);
      await makeReleaseImmutable(destination);
    } else {
      if (
        !destinationStatus.isDirectory() ||
        destinationStatus.isSymbolicLink()
      ) {
        throw new ReleaseError(
          'RELEASE_PATH_UNSAFE',
          'Installed release path is unsafe.',
        );
      }
      manifest = await validateReleaseArtifact(destination);
      if (JSON.stringify(manifest) !== JSON.stringify(sourceManifest)) {
        throw new ReleaseError(
          'RELEASE_INTEGRITY_MISMATCH',
          'Installed release id has different contents.',
        );
      }
    }
    const snapshot = await this.#snapshot(layout);
    if (snapshot.current === releaseId) {
      return receipt('install', 'activated', releaseId, {
        previousReleaseId: snapshot.previous,
        pointerSwitched: false,
        servicesVerified: true,
      });
    }
    try {
      await this.#hooks.beforeSwitch?.(destination, manifest);
    } catch {
      return receipt('install', 'failed_before_switch', releaseId, {
        previousReleaseId: snapshot.current,
        pointerSwitched: false,
        servicesVerified: false,
        reasonCode: 'PRE_SWITCH_VALIDATION_FAILED',
      });
    }
    await writeLauncher(layout);
    await atomicPointer(layout.previousPointer, snapshot.current);
    await atomicPointer(layout.currentPointer, releaseId);
    try {
      await this.#activate(layout, releaseId);
      return receipt('install', 'activated', releaseId, {
        previousReleaseId: snapshot.current,
        pointerSwitched: true,
        servicesVerified: true,
      });
    } catch (activationError) {
      try {
        await this.#restorePointers(layout, snapshot);
        if (snapshot.current !== undefined)
          await this.#activate(layout, snapshot.current);
        else await this.#hooks.restorePrior?.();
        return receipt('install', 'failed_rolled_back', releaseId, {
          previousReleaseId: snapshot.current,
          pointerSwitched: true,
          servicesVerified: true,
          reasonCode: 'ACTIVATION_FAILED_ROLLBACK_SUCCEEDED',
          failureDetailCode: errorCode(activationError),
        });
      } catch (rollbackError) {
        await this.#hooks.safeStop?.().catch(() => undefined);
        return receipt('install', 'failed_safe_stop', releaseId, {
          previousReleaseId: snapshot.current,
          pointerSwitched: true,
          servicesVerified: false,
          reasonCode: 'ACTIVATION_AND_ROLLBACK_FAILED',
          failureDetailCode: errorCode(activationError),
          rollbackFailureDetailCode: errorCode(rollbackError),
        });
      }
    }
  }

  async rollback(): Promise<ReleaseReceipt> {
    const layout = await this.#layout();
    const snapshot = await this.#snapshot(layout);
    if (snapshot.current === undefined || snapshot.previous === undefined) {
      throw new ReleaseError(
        'RELEASE_NOT_FOUND',
        'Current and previous releases are required for rollback.',
      );
    }
    const targetPath = path.join(layout.releasesRoot, snapshot.previous);
    const manifest = await validateReleaseArtifact(targetPath);
    try {
      await this.#hooks.beforeSwitch?.(targetPath, manifest);
    } catch {
      return receipt('rollback', 'failed_before_switch', snapshot.previous, {
        previousReleaseId: snapshot.current,
        pointerSwitched: false,
        servicesVerified: false,
        reasonCode: 'PRE_SWITCH_VALIDATION_FAILED',
      });
    }
    await atomicPointer(layout.previousPointer, snapshot.current);
    await atomicPointer(layout.currentPointer, snapshot.previous);
    try {
      await this.#activate(layout, snapshot.previous);
      return receipt('rollback', 'rolled_back', snapshot.previous, {
        previousReleaseId: snapshot.current,
        pointerSwitched: true,
        servicesVerified: true,
      });
    } catch (activationError) {
      try {
        await this.#restorePointers(layout, snapshot);
        await this.#activate(layout, snapshot.current);
        return receipt('rollback', 'failed_rolled_back', snapshot.previous, {
          previousReleaseId: snapshot.current,
          pointerSwitched: true,
          servicesVerified: true,
          reasonCode: 'ROLLBACK_TARGET_FAILED_CURRENT_RESTORED',
          failureDetailCode: errorCode(activationError),
        });
      } catch (restoreError) {
        await this.#hooks.safeStop?.().catch(() => undefined);
        return receipt('rollback', 'failed_safe_stop', snapshot.previous, {
          previousReleaseId: snapshot.current,
          pointerSwitched: true,
          servicesVerified: false,
          reasonCode: 'ROLLBACK_AND_RESTORE_FAILED',
          failureDetailCode: errorCode(activationError),
          rollbackFailureDetailCode: errorCode(restoreError),
        });
      }
    }
  }
}
