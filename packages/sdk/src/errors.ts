export type LocalinkErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SYMLINK_ESCAPE'
  | 'STALE_PRECONDITION'
  | 'EXPECTED_TEXT_MISMATCH'
  | 'BINARY_NOT_SUPPORTED'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'PROCESS_TIMEOUT'
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_NOT_RUNNING'
  | 'IO_ERROR'
  | 'CONFIG_INVALID'
  | 'CONTRACT_INVALID'
  | 'MODULE_NOT_FOUND'
  | 'MODULE_DISABLED'
  | 'MODULE_LIFECYCLE_FAILED'
  | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_UNAVAILABLE'
  | 'IDENTITY_REQUIRED'
  | 'SCOPE_REQUIRED'
  | 'POLICY_CONFIRMATION_REQUIRED'
  | 'POLICY_DENIED'
  | 'VERIFICATION_REQUIRED'
  | 'SECRET_PROVIDER_ERROR'
  | 'SKILL_NOT_FOUND';

export interface LocalinkErrorShape {
  code: LocalinkErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export class LocalinkError extends Error implements LocalinkErrorShape {
  readonly code: LocalinkErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: LocalinkErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalinkError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  toJSON(): LocalinkErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isLocalinkError(value: unknown): value is LocalinkError {
  return value instanceof LocalinkError;
}
