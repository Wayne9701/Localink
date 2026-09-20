import { LocalinkError } from '@localink/sdk';

const messages = {
  INVALID_ARGUMENT: 'Invalid tool arguments.',
  NOT_FOUND: 'Requested resource was not found.',
  ALREADY_EXISTS: 'Destination already exists.',
  PATH_OUTSIDE_WORKSPACE: 'Path is outside the registered workspace.',
  SYMLINK_ESCAPE: 'A symlink would escape the registered workspace.',
  STALE_PRECONDITION: 'File hash precondition did not match.',
  EXPECTED_TEXT_MISMATCH: 'Expected text occurrence count did not match.',
  BINARY_NOT_SUPPORTED:
    'Binary content is not supported by this text operation.',
  PROCESS_NOT_FOUND: 'Managed process was not found.',
  PROCESS_NOT_RUNNING: 'Managed process is not running.',
  POLICY_DENIED: 'Operation is disabled by local policy.',
  CAPABILITY_NOT_FOUND: 'Capability was not found.',
  SKILL_NOT_FOUND: 'Skill was not found.',
  IDENTITY_REQUIRED: 'An explicit matching identity is required.',
  SCOPE_REQUIRED: 'Required scopes are missing.',
  VERIFICATION_REQUIRED: 'A successful post-write verification is required.',
  CAPABILITY_UNAVAILABLE: 'Capability is unavailable or its handler failed.',
  MODULE_DISABLED: 'Module is disabled.',
  SIZE_LIMIT_EXCEEDED: 'Input exceeds the allowed size.',
  CONTRACT_INVALID: 'The runtime contract is invalid.',
  IO_ERROR: 'Localink could not complete the I/O operation.',
} as const;

export function publicError(error: unknown) {
  // Never serialize thrown messages, stack, cause, or details (even Localink errors).
  if (error instanceof LocalinkError && Object.hasOwn(messages, error.code)) {
    const code = error.code as keyof typeof messages;
    return {
      layer: 'localink',
      code,
      message: messages[code],
      ...(code === 'CAPABILITY_UNAVAILABLE' &&
      error.message === 'Capability handler failed.'
        ? { reasonCode: 'CAPABILITY_HANDLER_FAILED' }
        : {}),
    };
  }
  return {
    layer: 'localink',
    code: 'INTERNAL_ERROR',
    message: 'Localink could not complete the operation.',
  };
}

export function invalidInput(): never {
  throw new LocalinkError('INVALID_ARGUMENT', 'Invalid tool arguments.');
}

export function logTransportFailure(): void {
  process.stderr.write('Localink transport failure.\n');
}
