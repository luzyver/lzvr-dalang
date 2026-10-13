export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who a request is from. The owner is whoever holds the main access token (always an admin). */
export interface AuthUser {
  id: string | null;
  name: string;
  role: 'admin' | 'dev';
  /** True only for the main access token itself, not for a passkey session or a panel user. */
  main: boolean;
}

export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export const DEFAULT_AUTOPILOT_PROMPT =
  'Continue working on the task. When everything is finished, reply with a line containing only AUTOPILOT_DONE.';
