export type ReleaseErrorCode =
  | 'RELEASE_INPUT_INVALID'
  | 'RELEASE_ARTIFACT_INVALID'
  | 'RELEASE_INTEGRITY_MISMATCH'
  | 'RELEASE_PATH_UNSAFE'
  | 'RELEASE_NOT_FOUND'
  | 'RELEASE_ACTIVATION_FAILED'
  | 'RELEASE_ROLLBACK_FAILED';

export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;

  constructor(code: ReleaseErrorCode, message: string) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
  }
}
