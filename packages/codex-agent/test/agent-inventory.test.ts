import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentInventory } from '../src/agent-inventory.js';

test('Agent inventory rejects a symlink in place of its private state file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'localink-inventory-'));
  try {
    const inventory = new AgentInventory(root);
    const target = path.join(root, 'other.json');
    await mkdir(path.dirname(inventory.path), { recursive: true });
    await writeFile(target, '{"version":1,"tasks":[]}', { mode: 0o600 });
    await symlink(target, inventory.path);
    await assert.rejects(
      () => inventory.read(),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'AGENT_INVENTORY_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
