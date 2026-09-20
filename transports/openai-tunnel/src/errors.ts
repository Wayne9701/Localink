export type TunnelAdapterErrorCode =
  | 'BINARY_MISSING'
  | 'BINARY_NOT_EXECUTABLE'
  | 'BINARY_PROBE_FAILED'
  | 'VERSION_MALFORMED'
  | 'PROFILE_INVALID'
  | 'PROFILE_STALE'
  | 'PROFILE_IO_FAILED'
  | 'SECRET_UNAVAILABLE'
  | 'DOCTOR_OUTPUT_MALFORMED';

export class TunnelAdapterError extends Error {
  readonly code: TunnelAdapterErrorCode;

  constructor(code: TunnelAdapterErrorCode, message: string) {
    super(message);
    this.name = 'TunnelAdapterError';
    this.code = code;
  }
}
