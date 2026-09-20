import { LocalinkError } from '@localink/sdk';

const messages = {
  INVALID_ARGUMENT: 'Invalid tool arguments.',
  CAPABILITY_NOT_FOUND: 'Capability was not found.',
  SKILL_NOT_FOUND: 'Skill was not found.',
  IDENTITY_REQUIRED: 'An explicit matching identity is required.',
  SCOPE_REQUIRED: 'Required scopes are missing.',
  VERIFICATION_REQUIRED: 'A successful post-write verification is required.',
  CAPABILITY_UNAVAILABLE: 'Capability is unavailable or its handler failed.',
  MODULE_DISABLED: 'Module is disabled.',
  SIZE_LIMIT_EXCEEDED: 'Input exceeds the allowed size.',
  CONTRACT_INVALID: 'The runtime contract is invalid.',
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
