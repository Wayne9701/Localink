#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FilesService,
  ProcessManager,
  WorkspaceRegistry,
  createStatePaths,
} from '@localink/core';
import { createLocalinkRuntime } from '@localink/runtime';
import { LocalinkError, LOCALINK_VERSION } from '@localink/sdk';

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function selfTest(): Promise<void> {
  const fixture = await mkdtemp(path.join(tmpdir(), 'localink-self-test-'));
  try {
    const workspaceRoot = path.join(fixture, 'workspace');
    const stateRoot = path.join(fixture, 'state-root');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspaceRoot);
    const workspaces = new WorkspaceRegistry();
    const workspace = await workspaces.register('self-test', workspaceRoot);
    const files = new FilesService(workspaces, createStatePaths(stateRoot));
    const created = await files.createText(
      workspace.id,
      'hello.txt',
      'hello\n',
    );
    const edited = await files.preciseEdit({
      workspaceId: workspace.id,
      relativePath: 'hello.txt',
      expectedText: 'hello',
      replacementText: 'localink',
      expectedSha256: created.sha256,
      expectedOccurrences: 1,
    });
    const processes = new ProcessManager(workspaces);
    const processReceipt = await processes.exec({
      command: process.execPath,
      args: ['-e', "process.stdout.write('process-ok')"],
      workspaceId: workspace.id,
    });
    output({
      ok: processReceipt.exitCode === 0,
      version: LOCALINK_VERSION,
      checks: {
        workspace: workspace.id.length > 0,
        files: edited.occurrences === 1,
        process: processReceipt.stdout.text === 'process-ok',
      },
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv
    .slice(2)
    .filter((argument) => argument !== '--json');
  if (args.length === 2 && args[0] === 'core' && args[1] === 'self-test') {
    await selfTest();
    return;
  }

  const runtime = await createLocalinkRuntime();
  try {
    if (args.length === 2 && args[0] === 'runtime' && args[1] === 'health') {
      output(await runtime.health());
      return;
    }
    if (
      args.length === 4 &&
      args[0] === 'workspace' &&
      args[1] === 'add' &&
      args[2] !== undefined &&
      args[3] !== undefined
    ) {
      output(await runtime.addWorkspace(args[2], args[3]));
      return;
    }
    if (args.length === 2 && args[0] === 'workspace' && args[1] === 'list') {
      output({ workspaces: runtime.workspaces.list() });
      return;
    }
    if (
      args.length === 3 &&
      args[0] === 'workspace' &&
      args[1] === 'inspect' &&
      args[2] !== undefined
    ) {
      output(runtime.workspaces.inspect(args[2]));
      return;
    }
    if (
      args.length === 3 &&
      args[0] === 'workspace' &&
      args[1] === 'remove' &&
      args[2] !== undefined
    ) {
      output(await runtime.removeWorkspace(args[2]));
      return;
    }
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      'Usage: localink core self-test --json | runtime health --json | workspace add <name> <absolute-root> --json | workspace list --json | workspace inspect <id> --json | workspace remove <id> --json',
    );
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof LocalinkError) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error.toJSON() })}\n`,
    );
  } else {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: 'IO_ERROR', message: String(error) } })}\n`,
    );
  }
  process.exitCode = 1;
});
