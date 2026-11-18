export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who a request is from. The owner (`id` null) is whoever holds the main access token or signs in with an owner email. */
export interface AuthUser {
  id: string | null;
  name: string;
  /** True only for the main access token itself, not for a session or a panel user. */
  main: boolean;
}

export const BACKENDS = ['codex', 'claude'] as const;
export type Backend = (typeof BACKENDS)[number];

export const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

/**
 * Who may open a project, a database connection, an SSH host or key: 'all' = everyone, 'owner' = the owner alone (a
 * project: plus the users it is shared with, see canOpen).
 */
export const PROJECT_ACCESS = ['all', 'owner'] as const;
export type ProjectAccess = (typeof PROJECT_ACCESS)[number];

/** Whether `user` (the owner when `id` is null) may open something with this access. */
export function canAccess(user: { id: string | null }, access: string): boolean {
  return access === 'all' || user.id === null;
}

/** What was saved as 'admin' (the owner and admins, while users still had roles) is open to everyone now. */
export const currentAccess = <T extends { access: string }>(x: T): T => ((x.access as string) === 'admin' ? { ...x, access: 'all' } : x);

/** Whether `user` may open this project: its access level lets them in, or they are one of the users it is shared with. */
export function canOpen(user: { id: string | null }, p: { access: string; members?: readonly string[] }): boolean {
  return canAccess(user, p.access) || (!!user.id && !!p.members?.includes(user.id));
}
