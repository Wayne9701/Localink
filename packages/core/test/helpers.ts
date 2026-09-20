import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FilesService,
  WorkspaceRegistry,
  createStatePaths,
} from '../src/index.js';

export interface Fixture {
  root: string;
  workspaceRoot: string;
  stateRoot: string;
  workspaces: WorkspaceRegistry;
  workspaceId: string;
  files: FilesService;
}

export async function withFixture(
  worker: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-test-'));
  const workspaceRootInput = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'state-root');
  await mkdir(workspaceRootInput);
  const workspaces = new WorkspaceRegistry();
  const workspace = await workspaces.register('fixture', workspaceRootInput);
  const workspaceRoot = workspace.root;
  const files = new FilesService(workspaces, createStatePaths(stateRoot));
  try {
    await worker({
      root,
      workspaceRoot,
      stateRoot,
      workspaces,
      workspaceId: workspace.id,
      files,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
