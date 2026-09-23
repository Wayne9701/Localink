export type ServiceFoundationErrorCode =
  | 'INSTALLATION_CONTEXT_INVALID'
  | 'PLIST_INVALID'
  | 'LAUNCHCTL_TARGET_INVALID'
  | 'SERVICE_PREFLIGHT_FAILED'
  | 'LAUNCHCTL_BOOTOUT_FAILED'
  | 'LAUNCHCTL_UNLOAD_TIMEOUT'
  | 'LAUNCHCTL_BOOTSTRAP_FAILED'
  | 'LAUNCHCTL_REGISTRATION_TIMEOUT'
  | 'LAUNCHCTL_KICKSTART_FAILED'
  | 'LAUNCHCTL_STATUS_FAILED'
  | 'TUNNEL_SECRET_UNAVAILABLE'
  | 'TUNNEL_LAUNCH_FAILED'
  | 'RECOVERY_INPUT_INVALID';

export class ServiceFoundationError extends Error {
  readonly code: ServiceFoundationErrorCode;

  constructor(code: ServiceFoundationErrorCode, message: string) {
    super(message);
    this.name = 'ServiceFoundationError';
    this.code = code;
  }
}
