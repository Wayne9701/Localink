import { homedir } from 'node:os';
import path from 'node:path';
import type { StatePaths } from '@localink/sdk';

export function createStatePaths(
  root = path.join(homedir(), '.localink'),
): StatePaths {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    config: path.join(resolvedRoot, 'config'),
    state: path.join(resolvedRoot, 'state'),
    cache: path.join(resolvedRoot, 'cache'),
    logs: path.join(resolvedRoot, 'logs'),
    archive: path.join(resolvedRoot, 'archive'),
  };
}
