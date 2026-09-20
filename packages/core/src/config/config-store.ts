import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { LocalinkError, type StatePaths } from '@localink/sdk';
import { nodeErrorCode, wrapIoError } from '../internal/errors.js';

export type ConfigValidator<T> = (value: unknown) => T;

function assertConfigName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(name)) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      'Config name may contain only letters, numbers, underscore, and dash.',
      { name },
    );
  }
}

export class ConfigStore<T> {
  readonly #path: string;
  readonly #validator: ConfigValidator<T>;

  constructor(paths: StatePaths, name: string, validator: ConfigValidator<T>) {
    assertConfigName(name);
    this.#path = path.join(paths.config, `${name}.json`);
    this.#validator = validator;
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<T | undefined> {
    let source: string;
    try {
      source = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return undefined;
      throw wrapIoError('Unable to read config.', error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new LocalinkError(
        'CONFIG_INVALID',
        'Config contains malformed JSON.',
        { path: this.#path },
        error instanceof Error ? { cause: error } : undefined,
      );
    }
    return this.#validate(parsed);
  }

  async write(value: T): Promise<T> {
    const validated = this.#validate(value);
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    await mkdir(path.dirname(this.#path), { recursive: true });
    const temporaryPath = path.join(
      path.dirname(this.#path),
      `.${path.basename(this.#path)}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#path);
      return validated;
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw wrapIoError('Unable to atomically write config.', error);
    }
  }

  #validate(value: unknown): T {
    try {
      return this.#validator(value);
    } catch (error) {
      if (error instanceof LocalinkError && error.code === 'CONFIG_INVALID') {
        throw error;
      }
      throw new LocalinkError(
        'CONFIG_INVALID',
        'Config validation failed.',
        error instanceof Error ? { reason: error.message } : undefined,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }
}
