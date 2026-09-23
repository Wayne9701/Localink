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
  CONTRACT_VERSION_V1,
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
import {
  EXTERNAL_MCP_MODULE_ID,
  EXTERNAL_MCP_SCHEMA_VERSION,
  ExternalMcpManager,
  addExternalMcpProvider,
  removeExternalMcpProvider,
  validateExternalMcpConfig,
  validExternalMcpProviders,
  type ExternalMcpConfig,
  type ExternalMcpProvider,
} from './external-mcp.js';
import {
  SKILL_SOURCE_SCHEMA_VERSION,
  addSkillSource,
  loadSkillSources,
  removeSkillSource,
  validateSkillSourcesConfig,
  validSkillSources,
  type SkillSource,
  type SkillSourceLoadSummary,
  type SkillSourcesConfig,
} from './skill-sources.js';
import {
  readServiceSnapshot,
  unconfiguredServiceSnapshot,
  type PublicServiceSnapshot,
} from '@localink/service';

export interface WorkspaceConfigStore {
  read(): Promise<WorkspaceConfig | undefined>;
  write(value: WorkspaceConfig): Promise<WorkspaceConfig>;
}

export interface ProcessPolicyStore {
  read(): Promise<ProcessPolicy | undefined>;
  write(value: ProcessPolicy): Promise<ProcessPolicy>;
}

export interface SkillSourceStore {
  read(): Promise<SkillSourcesConfig | undefined>;
  write(value: SkillSourcesConfig): Promise<SkillSourcesConfig>;
}

export interface ExternalMcpStore {
  read(): Promise<ExternalMcpConfig | undefined>;
  write(value: ExternalMcpConfig): Promise<ExternalMcpConfig>;
}

export interface LocalinkRuntimeOptions {
  readonly stateRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly workspaceStore?: WorkspaceConfigStore;
  readonly processPolicyStore?: ProcessPolicyStore;
  readonly skillSourceStore?: SkillSourceStore;
  readonly externalMcpStore?: ExternalMcpStore;
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
  readonly sharedAssets: {
    readonly skillSources: {
      readonly configured: number;
      readonly loadedSkills: number;
      readonly degraded: number;
    };
    readonly externalMcp: ReturnType<ExternalMcpManager['health']>;
  };
  readonly service:
    | PublicServiceSnapshot
    | { readonly state: 'unconfigured'; readonly stale: true };
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
  readonly #skillSourceStore: SkillSourceStore;
  readonly #externalMcpStore: ExternalMcpStore;
  readonly #externalMcp: ExternalMcpManager;
  #processPolicy: ProcessPolicy;
  #skillSourceSummary: SkillSourceLoadSummary = {
    configuredSources: 0,
    loadedSkills: 0,
    degradedSources: 0,
    sources: [],
  };
  #mutationTail: Promise<void> = Promise.resolve();
  #workspaceSnapshotKey: string;
  #closed = false;

  private constructor(
    statePaths: StatePaths,
    workspaces: WorkspaceRegistry,
    workspaceStore: WorkspaceConfigStore,
    workspaceSnapshotKey: string,
    processPolicyStore: ProcessPolicyStore,
    processPolicy: ProcessPolicy,
    skillSourceStore: SkillSourceStore,
    externalMcpStore: ExternalMcpStore,
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
    this.#workspaceSnapshotKey = workspaceSnapshotKey;
    this.#processPolicyStore = processPolicyStore;
    this.#skillSourceStore = skillSourceStore;
    this.#externalMcpStore = externalMcpStore;
    this.#processPolicy = processPolicy;
    this.native = new NativeToolFacade(
      this.workspaces,
      this.files,
      this.processes,
      () => this.processPolicy(),
      environment,
    );
    this.#externalMcp = new ExternalMcpManager(this.capabilities, environment);
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
    const skillSourceStore =
      options.skillSourceStore ??
      new ConfigStore(statePaths, 'skill-sources', validateSkillSourcesConfig);
    const externalMcpStore =
      options.externalMcpStore ??
      new ConfigStore(statePaths, 'external-mcp', validateExternalMcpConfig);
    const workspaces = new WorkspaceRegistry();
    const config = await workspaceStore.read();
    await workspaces.replaceAllValidated(config?.workspaces ?? []);
    const processPolicy = (await processPolicyStore.read()) ?? {
      version: PROCESS_POLICY_SCHEMA_VERSION,
      enabled: false,
    };
    const runtime = new LocalinkRuntime(
      statePaths,
      workspaces,
      workspaceStore,
      JSON.stringify(config?.workspaces ?? []),
      processPolicyStore,
      processPolicy,
      skillSourceStore,
      externalMcpStore,
      options.environment ?? process.env,
    );
    await runtime.#initializeSharedAssets();
    return runtime;
  }

  async addWorkspace(name: string, root: string): Promise<WorkspaceRecord> {
    return this.#mutate(async () => {
      await this.#refreshWorkspacesIfChanged();
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
      await this.#refreshWorkspacesIfChanged();
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
    if (!this.#closed) await this.refreshWorkspaces();
    const service =
      (await readServiceSnapshot(this.statePaths.root)) ??
      unconfiguredServiceSnapshot();
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
      sharedAssets: {
        skillSources: {
          configured: this.#skillSourceSummary.configuredSources,
          loadedSkills: this.#skillSourceSummary.loadedSkills,
          degraded: this.#skillSourceSummary.degradedSources,
        },
        externalMcp: this.#externalMcp.health(),
      },
      service,
    };
  }

  async refreshWorkspaces(): Promise<void> {
    await this.#mutate(() => this.#refreshWorkspacesIfChanged());
  }

  async skillSources(): Promise<SkillSource[]> {
    return validSkillSources(await this.#skillSourceStore.read());
  }

  async addSkillSource(id: string, root: string): Promise<SkillSource> {
    return this.#mutate(() => addSkillSource(this.#skillSourceStore, id, root));
  }

  async removeSkillSource(id: string): Promise<SkillSource> {
    return this.#mutate(() => removeSkillSource(this.#skillSourceStore, id));
  }

  async externalMcpProviders(): Promise<ExternalMcpProvider[]> {
    return validExternalMcpProviders(await this.#externalMcpStore.read());
  }

  async addHttpProvider(id: string, url: string): Promise<ExternalMcpProvider> {
    return this.#mutate(() =>
      addExternalMcpProvider(this.#externalMcpStore, {
        id,
        transport: 'loopback-http',
        url,
        enabled: true,
      }),
    );
  }

  async addStdioProvider(
    id: string,
    command: string,
    args: readonly string[],
  ): Promise<ExternalMcpProvider> {
    return this.#mutate(() =>
      addExternalMcpProvider(this.#externalMcpStore, {
        id,
        transport: 'stdio',
        command,
        args,
        enabled: true,
      }),
    );
  }

  async removeExternalMcpProvider(id: string): Promise<ExternalMcpProvider> {
    return this.#mutate(() =>
      removeExternalMcpProvider(this.#externalMcpStore, id),
    );
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
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([this.#externalMcp.close(), this.processes.close()]);
  }

  async #initializeSharedAssets(): Promise<void> {
    let skillConfig: SkillSourcesConfig | undefined;
    try {
      skillConfig = await this.#skillSourceStore.read();
    } catch {
      skillConfig = { version: SKILL_SOURCE_SCHEMA_VERSION, sources: [null] };
    }
    this.#skillSourceSummary = await loadSkillSources(skillConfig, this.skills);

    this.modules.register({
      manifest: {
        contractVersion: CONTRACT_VERSION_V1,
        id: EXTERNAL_MCP_MODULE_ID,
        version: '1.0.0',
        title: 'External MCP Read Bridge',
        runtime: { apiVersion: CONTRACT_VERSION_V1 },
      },
    });
    await this.modules.enable(EXTERNAL_MCP_MODULE_ID);
    let providerConfig: ExternalMcpConfig | undefined;
    try {
      providerConfig = await this.#externalMcpStore.read();
    } catch {
      providerConfig = {
        version: EXTERNAL_MCP_SCHEMA_VERSION,
        providers: [null],
      };
    }
    await this.#externalMcp.load(providerConfig);
  }

  async #persist(workspaces: WorkspaceRecord[]): Promise<void> {
    await this.#workspaceStore.write({
      version: WORKSPACE_SCHEMA_VERSION,
      workspaces,
    });
    this.#workspaceSnapshotKey = JSON.stringify(workspaces);
  }

  async #refreshWorkspacesIfChanged(): Promise<void> {
    const config = await this.#workspaceStore.read();
    const records = config?.workspaces ?? [];
    const nextKey = JSON.stringify(records);
    if (nextKey === this.#workspaceSnapshotKey) return;
    await this.workspaces.replaceAllValidated(records);
    this.#workspaceSnapshotKey = nextKey;
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
