import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createLocalinkRuntime } from '@localink/runtime';
import { PublicAdapter } from '../src/public-adapter.js';
import {
  PUBLIC_GIT_LIMITS,
  TOOL_NAMES,
  toolAnnotations,
  toolSchemas,
} from '../src/tool-definitions.js';
import { at, envelope } from './helpers.js';

const run = promisify(execFile);

async function git(cwd: string, args: readonly string[]) {
  return run('git', args, { cwd, encoding: 'utf8' });
}

async function withGitFixture(
  worker: (fixture: {
    root: string;
    workspaceRoot: string;
    workspaceId: string;
    runtime: Awaited<ReturnType<typeof createLocalinkRuntime>>;
    adapter: PublicAdapter;
    head: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-git-test-'));
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot);
  await git(workspaceRoot, ['init', '-q']);
  await writeFile(path.join(workspaceRoot, 'alpha.txt'), 'one\n');
  await writeFile(path.join(workspaceRoot, 'beta.txt'), 'beta\n');
  await git(workspaceRoot, ['add', 'alpha.txt', 'beta.txt']);
  await git(workspaceRoot, [
    '-c',
    'user.name=Fixture User',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'initial subject',
  ]);
  const head = (await git(workspaceRoot, ['rev-parse', 'HEAD'])).stdout.trim();
  const runtime = await createLocalinkRuntime({
    stateRoot: path.join(root, 'state'),
  });
  const workspace = await runtime.addWorkspace('git-fixture', workspaceRoot);
  try {
    await worker({
      root,
      workspaceRoot,
      workspaceId: workspace.id,
      runtime,
      adapter: new PublicAdapter(runtime),
      head,
    });
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function invoke(
  adapter: PublicAdapter,
  name: string,
  args: Record<string, unknown>,
) {
  return envelope(await adapter.call(`localink.${name}`, args));
}

test('registry is exact 27 and Git schemas are strict, bounded, and non-open-world', () => {
  assert.equal(TOOL_NAMES.length, 27);
  assert.equal(new Set(TOOL_NAMES).size, 27);
  for (const name of [
    'localink.git_inspect',
    'localink.git_status',
    'localink.git_diff',
    'localink.git_log',
    'localink.git_apply_patch',
  ] as const) {
    assert.equal(toolAnnotations[name].openWorldHint, false);
  }
  assert.equal(toolAnnotations['localink.git_inspect'].readOnlyHint, true);
  assert.equal(toolAnnotations['localink.git_apply_patch'].readOnlyHint, false);
  assert.equal(
    toolAnnotations['localink.git_apply_patch'].destructiveHint,
    false,
  );
  assert.equal(
    toolSchemas['localink.git_diff'].safeParse({
      workspaceId: 'workspace',
      scope: 'worktree',
      revision: 'HEAD~1',
    }).success,
    false,
  );
  assert.equal(PUBLIC_GIT_LIMITS.patchBytes, 256 * 1024);
});

test('Git read tools are structured, bounded, private-path safe, and independent of process policy', async () => {
  await withGitFixture(
    async ({ adapter, root, workspaceRoot, workspaceId, runtime, head }) => {
      const inspect = await invoke(adapter, 'git_inspect', { workspaceId });
      assert.equal(at(inspect, 'data', 'head'), head);
      assert.equal(at(inspect, 'data', 'bare'), false);
      assert.equal(at(inspect, 'data', 'detached'), false);
      assert.equal(JSON.stringify(inspect).includes(root), false);

      await writeFile(path.join(workspaceRoot, 'alpha.txt'), 'worktree\n');
      await writeFile(path.join(workspaceRoot, 'staged.txt'), 'staged\n');
      await git(workspaceRoot, ['add', 'staged.txt']);
      await writeFile(path.join(workspaceRoot, 'untracked.txt'), 'untracked\n');
      const status = await invoke(adapter, 'git_status', { workspaceId });
      const entries = at(status, 'data', 'entries') as Record<
        string,
        unknown
      >[];
      assert.deepEqual(entries.map((entry) => entry.path).sort(), [
        'alpha.txt',
        'staged.txt',
        'untracked.txt',
      ]);
      assert.equal(
        entries.find((entry) => entry.path === 'untracked.txt')?.kind,
        'untracked',
      );
      assert.equal(JSON.stringify(status).includes(root), false);

      const worktree = await invoke(adapter, 'git_diff', {
        workspaceId,
        scope: 'worktree',
        paths: ['alpha.txt'],
        contextLines: 0,
      });
      assert.match(String(at(worktree, 'data', 'diff')), /-one\n\+worktree/u);
      assert.deepEqual(at(worktree, 'data', 'paths'), ['alpha.txt']);
      const staged = await invoke(adapter, 'git_diff', {
        workspaceId,
        scope: 'staged',
        paths: ['staged.txt'],
      });
      assert.match(String(at(staged, 'data', 'diff')), /staged/u);

      const log = await invoke(adapter, 'git_log', { workspaceId, limit: 1 });
      const commit = (at(log, 'data') as Record<string, unknown>[])[0];
      assert.equal(commit?.hash, head);
      assert.equal(commit?.subject, 'initial subject');
      assert.equal(
        JSON.stringify(log).includes('fixture@example.invalid'),
        false,
      );
      assert.equal(runtime.processPolicy().enabled, false);
    },
  );
});

test('Git apply patch has HEAD preconditions, static safety checks, and rollback on failed execution', async () => {
  await withGitFixture(
    async ({ adapter, workspaceRoot, workspaceId, head }) => {
      const validPatch = [
        'diff --git a/alpha.txt b/alpha.txt',
        'index 5626abf..f719efd 100644',
        '--- a/alpha.txt',
        '+++ b/alpha.txt',
        '@@ -1 +1 @@',
        '-one',
        '+two',
        '',
      ].join('\n');
      const applied = await invoke(adapter, 'git_apply_patch', {
        workspaceId,
        expectedHead: head,
        patch: validPatch,
      });
      assert.equal(at(applied, 'data', 'verification', 'verified'), true);
      assert.equal(
        await readFile(path.join(workspaceRoot, 'alpha.txt'), 'utf8'),
        'two\n',
      );

      const createPatch = [
        'diff --git a/created.txt b/created.txt',
        'new file mode 100644',
        'index 0000000..3e75765',
        '--- /dev/null',
        '+++ b/created.txt',
        '@@ -0,0 +1 @@',
        '+created',
        '',
      ].join('\n');
      const created = await invoke(adapter, 'git_apply_patch', {
        workspaceId,
        expectedHead: head,
        patch: createPatch,
      });
      assert.equal(at(created, 'data', 'verification', 'verified'), true);
      assert.equal(
        await readFile(path.join(workspaceRoot, 'created.txt'), 'utf8'),
        'created\n',
      );

      const stale = await invoke(adapter, 'git_apply_patch', {
        workspaceId,
        expectedHead: '0'.repeat(40),
        patch: validPatch,
      });
      assert.equal(at(stale, 'data', 'error', 'code'), 'STALE_PRECONDITION');
      assert.equal(
        await readFile(path.join(workspaceRoot, 'alpha.txt'), 'utf8'),
        'two\n',
      );

      const partialFailure = [
        'diff --git a/alpha.txt b/alpha.txt',
        'index f719efd..814f4a4 100644',
        '--- a/alpha.txt',
        '+++ b/alpha.txt',
        '@@ -1 +1 @@',
        '-two',
        '+three',
        'diff --git a/beta.txt b/beta.txt',
        'index 5626abf..814f4a4 100644',
        '--- a/beta.txt',
        '+++ b/beta.txt',
        '@@ -1 +1 @@',
        '-not-present',
        '+would-write',
        '',
      ].join('\n');
      const rejected = await invoke(adapter, 'git_apply_patch', {
        workspaceId,
        expectedHead: head,
        patch: partialFailure,
      });
      assert.equal(at(rejected, 'data', 'error', 'code'), 'IO_ERROR');
      assert.equal(
        await readFile(path.join(workspaceRoot, 'alpha.txt'), 'utf8'),
        'two\n',
      );

      for (const patch of [
        validPatch
          .replace('--- a/alpha.txt', '--- /dev/null')
          .replace('+++ b/alpha.txt', '+++ /dev/null'),
        validPatch.replace(
          'diff --git a/alpha.txt b/alpha.txt',
          'diff --git a/alpha.txt b/other.txt',
        ),
        validPatch.replace('index 5626abf..f719efd 100644', 'new mode 120000'),
        validPatch.replace('@@ -1 +1 @@', 'GIT binary patch'),
      ]) {
        const unsafe = await invoke(adapter, 'git_apply_patch', {
          workspaceId,
          expectedHead: head,
          patch,
        });
        assert.equal(at(unsafe, 'data', 'error') !== undefined, true);
        assert.equal(
          await readFile(path.join(workspaceRoot, 'alpha.txt'), 'utf8'),
          'two\n',
        );
      }
    },
  );
});

test('Git repository resolution rejects outer repositories and permits nested repositories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'localink-git-boundary-'));
  const outer = path.join(root, 'outer');
  const workspace = path.join(outer, 'workspace');
  await mkdir(workspace, { recursive: true });
  await git(outer, ['init', '-q']);
  await mkdir(path.join(workspace, 'nested'));
  await git(path.join(workspace, 'nested'), ['init', '-q']);
  await writeFile(path.join(workspace, 'nested', 'file.txt'), 'nested\n');
  await git(path.join(workspace, 'nested'), ['add', 'file.txt']);
  await git(path.join(workspace, 'nested'), [
    '-c',
    'user.name=Nested',
    '-c',
    'user.email=nested@example.invalid',
    'commit',
    '-qm',
    'nested',
  ]);
  const runtime = await createLocalinkRuntime({
    stateRoot: path.join(root, 'state'),
  });
  const record = await runtime.addWorkspace('boundary', workspace);
  const adapter = new PublicAdapter(runtime);
  try {
    const outside = await invoke(adapter, 'git_inspect', {
      workspaceId: record.id,
    });
    assert.equal(
      at(outside, 'data', 'error', 'code'),
      'PATH_OUTSIDE_WORKSPACE',
    );
    const nested = await invoke(adapter, 'git_inspect', {
      workspaceId: record.id,
      repoPath: 'nested',
    });
    assert.equal(at(nested, 'data', 'repoPath'), 'nested');
    assert.equal(JSON.stringify(nested).includes(root), false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
