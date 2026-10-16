export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who a request is from. The owner is whoever holds the main access token (always an admin). */
export interface AuthUser {
  id: string | null;
  name: string;
  role: 'admin' | 'dev';
  /** True only for the main access token itself, not for a session or a panel user. */
  main: boolean;
}

export const BACKENDS = ['codex', 'claude'] as const;
export type Backend = (typeof BACKENDS)[number];

export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

/** Who may open a project: 'all' = everyone, 'admin' = the owner and the admins, 'owner' = the owner alone. */
export const PROJECT_ACCESS = ['all', 'admin', 'owner'] as const;
export type ProjectAccess = (typeof PROJECT_ACCESS)[number];

/** Whether `user` (the owner when `id` is null) may open a project with this access. */
export function canAccess(user: { id: string | null; role: 'admin' | 'dev' | null }, access: string): boolean {
  return access === 'all' || user.id === null || (access === 'admin' && user.role === 'admin');
}
