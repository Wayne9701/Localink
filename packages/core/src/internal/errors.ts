import { LocalinkError, type LocalinkErrorCode } from '@localink/sdk';

export interface NodeError extends Error {
  code?: string;
}

export function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeError).code : undefined;
}

export function wrapIoError(
  message: string,
  error: unknown,
  code: LocalinkErrorCode = 'IO_ERROR',
): LocalinkError {
  if (error instanceof LocalinkError) {
    return error;
  }
  return new LocalinkError(
    code,
    message,
    error instanceof Error
      ? { causeName: error.name, causeMessage: error.message }
      : undefined,
    error instanceof Error ? { cause: error } : undefined,
  );
}
