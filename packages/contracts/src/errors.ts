// Error taxonomy (manual §40). Only categories listed as retryable may be retried automatically.
export const ErrorKind = [
  'model_auth', 'model_rate_limit', 'model_unavailable', 'tool_timeout', 'process_crash', 'policy_deny',
  'workspace_conflict', 'resource_limit', 'test_fail', 'deployment_fail', 'network_unavailable', 'stale_session', 'invalid_request', 'internal',
] as const;
export type ErrorKind = (typeof ErrorKind)[number];

export const RETRYABLE: ReadonlySet<ErrorKind> = new Set(['model_rate_limit', 'network_unavailable']);

export class AtlasError extends Error {
  constructor(public readonly kind: ErrorKind, message: string) {
    super(message);
    this.name = 'AtlasError';
  }
}
