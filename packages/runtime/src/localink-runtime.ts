import {
  CapabilityRegistry,
  ConfigStore,
  FilesService,
  ModuleRegistry,
  ProcessManager,
  SkillRegistry,
  WorkspaceRegistry,
  createStatePaths,
} from '@localink/core';
import {
  LOCALINK_VERSION,
  LocalinkError,
  type StatePaths,
  type WorkspaceRecord,
} from '@localink/sdk';
import {
  WORKSPACE_SCHEMA_VERSION,
  type WorkspaceConfig,
  validateWorkspaceConfig,
} from './workspace-config.js';

export interface WorkspaceConfigStore {
  read(): Promise<WorkspaceConfig | undefined>;
  write(value: WorkspaceConfig): Promise<WorkspaceConfig>;
}

export interface LocalinkRuntimeOptions {
  readonly stateRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly workspaceStore?: WorkspaceConfigStore;
}

export interface LocalinkRuntimeHealth {
  readonly mode: 'runtime';
  readonly version: string;
  readonly workspaceCount: number;
  readonly capabilityCount: number;
  readonly skillCount: number;
  readonly state: {
    readonly ready: boolean;
    readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  };
}

function resolveStateRoot(options: LocalinkRuntimeOptions): string | undefined {
  const configured =
    options.stateRoot ??
    (options.environment ?? process.env).LOCALINK_STATE_ROOT;
  if (configured === undefined) return undefined;
  if (configured.trim().length === 0 || configured.includes('\0')) {
    throw new LocalinkError(
      'INVALID_ARGUMENT',
      'LOCALINK_STATE_ROOT must be a non-empty filesystem path.',
    );
  }
  return configured;
}

export class LocalinkRuntime {
  readonly statePaths: StatePaths;
  readonly workspaces: WorkspaceRegistry;
  readonly files: FilesService;
  readonly processes: ProcessManager;
  readonly modules: ModuleRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly skills: SkillRegistry;
  readonly #workspaceStore: WorkspaceConfigStore;
  #mutationTail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    statePaths: StatePaths,
    workspaces: WorkspaceRegistry,
    workspaceStore: WorkspaceConfigStore,
  ) {
    this.statePaths = statePaths;
    this.workspaces = workspaces;
    this.files = new FilesService(workspaces, statePaths);
    this.processes = new ProcessManager(workspaces);
    this.modules = new ModuleRegistry();
    this.capabilities = new CapabilityRegistry({
      isModuleEnabled: (moduleId) => this.modules.isEnabled(moduleId),
    });
    this.skills = new SkillRegistry();
    this.#workspaceStore = workspaceStore;
  }

  static async create(
    options: LocalinkRuntimeOptions = {},
  ): Promise<LocalinkRuntime> {
    const statePaths = createStatePaths(resolveStateRoot(options));
    const workspaceStore =
      options.workspaceStore ??
      new ConfigStore(statePaths, 'workspaces', validateWorkspaceConfig);
    const workspaces = new WorkspaceRegistry();
    const config = await workspaceStore.read();
    for (const record of config?.workspaces ?? []) {
      await workspaces.restore(record);
    }
    return new LocalinkRuntime(statePaths, workspaces, workspaceStore);
  }

  async addWorkspace(name: string, root: string): Promise<WorkspaceRecord> {
    return this.#mutate(async () => {
      const record = await this.workspaces.register(name, root);
      try {
        await this.#persist(this.workspaces.list());
      } catch (error) {
        this.workspaces.remove(record.id);
        throw error;
      }
      return record;
    });
  }

  async removeWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
    return this.#mutate(async () => {
      const record = this.workspaces.inspect(workspaceId);
      const remaining = this.workspaces
        .list()
        .filter((workspace) => workspace.id !== workspaceId);
      await this.#persist(remaining);
      this.workspaces.remove(workspaceId);
      return record;
    });
  }

  async health(): Promise<LocalinkRuntimeHealth> {
    return {
      mode: 'runtime',
      version: LOCALINK_VERSION.version,
      workspaceCount: this.workspaces.list().length,
      capabilityCount: this.capabilities.list().length,
      skillCount: this.skills.list().length,
      state: {
        ready: !this.#closed,
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
      },
    };
  }

  validateInput(capabilityId: string): void {
    this.capabilities.describe(capabilityId);
  }

  async close(): Promise<void> {
    await this.#mutationTail;
    this.#closed = true;
  }

  async #persist(workspaces: WorkspaceRecord[]): Promise<void> {
    await this.#workspaceStore.write({
      version: WORKSPACE_SCHEMA_VERSION,
      workspaces,
    });
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(async () => {
      if (this.#closed) {
        throw new LocalinkError('IO_ERROR', 'Localink runtime is closed.');
      }
      return operation();
    });
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function createLocalinkRuntime(
  options: LocalinkRuntimeOptions = {},
): Promise<LocalinkRuntime> {
  return LocalinkRuntime.create(options);
}
