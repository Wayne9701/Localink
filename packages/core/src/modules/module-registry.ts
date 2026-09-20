import {
  LocalinkError,
  type ModuleDefinition,
  type ModuleDescriptor,
  type ModuleHealthResult,
  type ModuleLifecycleReceipt,
  type ModuleState,
} from '@localink/sdk';
import { validateModuleManifest } from '../contracts/validation.js';

interface ModuleEntry {
  definition: ModuleDefinition;
  state: ModuleState;
  initialized: boolean;
  failure?: { code: string; message: string };
}

function descriptor(entry: ModuleEntry): ModuleDescriptor {
  return {
    manifest: structuredClone(entry.definition.manifest),
    state: entry.state,
    initialized: entry.initialized,
    ...(entry.failure === undefined ? {} : { failure: { ...entry.failure } }),
  };
}

function receipt(
  moduleId: string,
  operation: ModuleLifecycleReceipt['operation'],
  ok: boolean,
  state: ModuleState,
  reasonCode: string,
  message: string,
): ModuleLifecycleReceipt {
  return { moduleId, operation, ok, state, reasonCode, message };
}

export class ModuleRegistry {
  readonly #entries = new Map<string, ModuleEntry>();

  register(definition: ModuleDefinition): ModuleLifecycleReceipt {
    validateModuleManifest(definition.manifest);
    const moduleId = definition.manifest.id;
    if (this.#entries.has(moduleId)) {
      throw new LocalinkError(
        'ALREADY_EXISTS',
        'Module is already registered.',
        {
          moduleId,
        },
      );
    }
    this.#entries.set(moduleId, {
      definition,
      state: 'registered',
      initialized: false,
    });
    return receipt(
      moduleId,
      'register',
      true,
      'registered',
      'MODULE_REGISTERED',
      'Module registered.',
    );
  }

  install(definition: ModuleDefinition): ModuleLifecycleReceipt {
    return this.register(definition);
  }

  list(): ModuleDescriptor[] {
    return [...this.#entries.values()]
      .map(descriptor)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  discover(query = ''): ModuleDescriptor[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized.length === 0) return this.list();
    return this.list().filter((item) =>
      [item.manifest.id, item.manifest.title].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    );
  }

  inspect(moduleId: string): ModuleDescriptor {
    return descriptor(this.#get(moduleId));
  }

  isEnabled(moduleId: string): boolean {
    return this.#entries.get(moduleId)?.state === 'enabled';
  }

  async enable(moduleId: string): Promise<ModuleLifecycleReceipt> {
    const entry = this.#get(moduleId);
    if (entry.state === 'enabled') {
      return receipt(
        moduleId,
        'enable',
        true,
        'enabled',
        'MODULE_ALREADY_ENABLED',
        'Module is already enabled.',
      );
    }
    const context = { moduleId };
    try {
      if (!entry.initialized) {
        await entry.definition.initialize?.(context);
        entry.initialized = true;
      }
      await entry.definition.enable?.(context);
      entry.state = 'enabled';
      delete entry.failure;
      return receipt(
        moduleId,
        'enable',
        true,
        'enabled',
        'MODULE_ENABLED',
        'Module enabled.',
      );
    } catch {
      entry.state = 'error';
      entry.failure = {
        code: 'MODULE_ENABLE_FAILED',
        message: 'Module initialization or enable lifecycle failed.',
      };
      return receipt(
        moduleId,
        'enable',
        false,
        'error',
        entry.failure.code,
        entry.failure.message,
      );
    }
  }

  async disable(moduleId: string): Promise<ModuleLifecycleReceipt> {
    const entry = this.#get(moduleId);
    if (entry.state === 'disabled' || entry.state === 'registered') {
      entry.state = 'disabled';
      return receipt(
        moduleId,
        'disable',
        true,
        'disabled',
        'MODULE_ALREADY_DISABLED',
        'Module is already disabled.',
      );
    }
    try {
      await entry.definition.disable?.({ moduleId });
      entry.state = 'disabled';
      delete entry.failure;
      return receipt(
        moduleId,
        'disable',
        true,
        'disabled',
        'MODULE_DISABLED',
        'Module disabled.',
      );
    } catch {
      entry.state = 'error';
      entry.failure = {
        code: 'MODULE_DISABLE_FAILED',
        message: 'Module disable lifecycle failed.',
      };
      return receipt(
        moduleId,
        'disable',
        false,
        'error',
        entry.failure.code,
        entry.failure.message,
      );
    }
  }

  async health(moduleId: string): Promise<ModuleHealthResult> {
    const entry = this.#get(moduleId);
    const checkedAt = new Date().toISOString();
    if (entry.state !== 'enabled') {
      return {
        moduleId,
        status: 'disabled',
        checkedAt,
        reasonCode: 'MODULE_NOT_ENABLED',
        message: 'Module health is unavailable while the module is disabled.',
      };
    }
    if (entry.definition.health === undefined) {
      return { moduleId, status: 'healthy', checkedAt };
    }
    try {
      const result = await entry.definition.health({ moduleId });
      if (!['healthy', 'degraded', 'unhealthy'].includes(result.status)) {
        return {
          moduleId,
          status: 'unhealthy',
          checkedAt,
          reasonCode: 'MODULE_HEALTH_INVALID',
          message: 'Module health probe returned an invalid result.',
        };
      }
      return { ...result, moduleId, checkedAt };
    } catch {
      return {
        moduleId,
        status: 'unhealthy',
        checkedAt,
        reasonCode: 'MODULE_HEALTH_FAILED',
        message: 'Module health probe failed.',
      };
    }
  }

  #get(moduleId: string): ModuleEntry {
    const entry = this.#entries.get(moduleId);
    if (entry === undefined) {
      throw new LocalinkError('MODULE_NOT_FOUND', 'Module was not found.', {
        moduleId,
      });
    }
    return entry;
  }
}
