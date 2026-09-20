import type {
  AuthProvider,
  AuthStatus,
  AuthStatusRequest,
  IdentitySummary,
  SecretRef,
} from '@localink/sdk';

export interface FixtureAuthProviderOptions {
  readonly id: string;
  readonly configured?: boolean;
  readonly loginIdentity?: IdentitySummary;
  readonly grantedScopes?: readonly string[];
  readonly requiredScopes?: readonly string[];
  readonly refreshReady?: boolean;
  readonly credentialRef?: SecretRef;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export class FixtureAuthProvider implements AuthProvider {
  readonly id: string;
  readonly #loginIdentity: IdentitySummary | undefined;
  readonly #configuredScopes: readonly string[];
  readonly #defaultRequiredScopes: readonly string[];
  readonly #refreshCapable: boolean;
  readonly #credentialRef: SecretRef | undefined;
  #configured: boolean;
  #identity: IdentitySummary | undefined;
  #grantedScopes: readonly string[] = [];

  constructor(options: FixtureAuthProviderOptions) {
    this.id = options.id;
    this.#configured = options.configured ?? false;
    this.#loginIdentity = options.loginIdentity;
    this.#configuredScopes = uniqueSorted(options.grantedScopes ?? []);
    this.#defaultRequiredScopes = uniqueSorted(options.requiredScopes ?? []);
    this.#refreshCapable = options.refreshReady ?? true;
    this.#credentialRef = options.credentialRef;
  }

  async status(request: AuthStatusRequest = {}): Promise<AuthStatus> {
    const required = uniqueSorted(
      request.requiredScopes ?? this.#defaultRequiredScopes,
    );
    const granted = uniqueSorted(this.#grantedScopes);
    const grantedSet = new Set(granted);
    const missing = required.filter((scope) => !grantedSet.has(scope));
    const state = !this.#configured
      ? 'not_configured'
      : this.#identity === undefined
        ? 'signed_out'
        : missing.length === 0
          ? 'ready'
          : 'degraded';
    return {
      providerId: this.id,
      state,
      ...(this.#identity === undefined
        ? {}
        : { identity: structuredClone(this.#identity) }),
      scopes: { granted, required, missing },
      refreshReady:
        this.#configured &&
        this.#identity !== undefined &&
        this.#refreshCapable,
      ...(this.#credentialRef === undefined
        ? {}
        : { credentialRef: structuredClone(this.#credentialRef) }),
    };
  }

  async setup(): Promise<AuthStatus> {
    this.#configured = true;
    return this.status();
  }

  async login(): Promise<AuthStatus> {
    this.#configured = true;
    this.#identity =
      this.#loginIdentity === undefined
        ? undefined
        : structuredClone(this.#loginIdentity);
    this.#grantedScopes =
      this.#identity === undefined ? [] : [...this.#configuredScopes];
    return this.status();
  }

  async refresh(): Promise<AuthStatus> {
    return this.status();
  }

  async logout(): Promise<AuthStatus> {
    this.#identity = undefined;
    this.#grantedScopes = [];
    return this.status();
  }
}
