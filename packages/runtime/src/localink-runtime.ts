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
import {
  PROCESS_POLICY_SCHEMA_VERSION,
  type ProcessPolicy,
  validateProcessPolicy,
} from './process-policy.js';
import { NativeToolFacade } from './native-tools.js';

export interface WorkspaceConfigStore {
  read(): Promise<WorkspaceConfig | undefined>;
  write(value: WorkspaceConfig): Promise<WorkspaceConfig>;
}

export interface ProcessPolicyStore {
  read(): Promise<ProcessPolicy | undefined>;
  write(value: ProcessPolicy): Promise<ProcessPolicy>;
}

export interface LocalinkRuntimeOptions {
  readonly stateRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly workspaceStore?: WorkspaceConfigStore;
  readonly processPolicyStore?: ProcessPolicyStore;
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
  readonly processPolicy: {
    readonly enabled: boolean;
    readonly shell: false;
    readonly osSandbox: false;
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
  readonly native: NativeToolFacade;
  readonly #workspaceStore: WorkspaceConfigStore;
  readonly #processPolicyStore: ProcessPolicyStore;
  #processPolicy: ProcessPolicy;
  #mutationTail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    statePaths: StatePaths,
    workspaces: WorkspaceRegistry,
    workspaceStore: WorkspaceConfigStore,
    processPolicyStore: ProcessPolicyStore,
    processPolicy: ProcessPolicy,
    environment: NodeJS.ProcessEnv,
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
    this.#processPolicyStore = processPolicyStore;
    this.#processPolicy = processPolicy;
    this.native = new NativeToolFacade(
      this.workspaces,
      this.files,
      this.processes,
      () => this.processPolicy(),
      environment,
    );
  }

  static async create(
    options: LocalinkRuntimeOptions = {},
  ): Promise<LocalinkRuntime> {
    const statePaths = createStatePaths(resolveStateRoot(options));
    const workspaceStore =
      options.workspaceStore ??
      new ConfigStore(statePaths, 'workspaces', validateWorkspaceConfig);
    const processPolicyStore =
      options.processPolicyStore ??
      new ConfigStore(statePaths, 'process-policy', validateProcessPolicy);
    const workspaces = new WorkspaceRegistry();
    const config = await workspaceStore.read();
    for (const record of config?.workspaces ?? []) {
      await workspaces.restore(record);
    }
    const processPolicy = (await processPolicyStore.read()) ?? {
      version: PROCESS_POLICY_SCHEMA_VERSION,
      enabled: false,
    };
    return new LocalinkRuntime(
      statePaths,
      workspaces,
      workspaceStore,
      processPolicyStore,
      processPolicy,
      options.environment ?? process.env,
    );
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
      processPolicy: {
        enabled: this.#processPolicy.enabled,
        shell: false,
        osSandbox: false,
      },
    };
  }

  processPolicy(): ProcessPolicy {
    return { ...this.#processPolicy };
  }

  async setProcessEnabled(enabled: boolean): Promise<ProcessPolicy> {
    return this.#mutate(async () => {
      const policy = await this.#processPolicyStore.write({
        version: PROCESS_POLICY_SCHEMA_VERSION,
        enabled,
      });
      this.#processPolicy = policy;
      return { ...policy };
    });
  }

  validateInput(capabilityId: string): void {
    this.capabilities.describe(capabilityId);
  }

  async close(): Promise<void> {
    await this.#mutationTail;
    this.#closed = true;
    await this.processes.close();
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
