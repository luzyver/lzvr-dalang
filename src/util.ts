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

/**
 * Who may open a project, as the lowest role that may: 'owner' = the owner alone, 'admin' = the owner and the admins,
 * 'dev' (like 'all') = the owner, admins and devs.
 */
export const PROJECT_ACCESS = ['all', 'owner', 'admin', 'dev'] as const;
export type ProjectAccess = (typeof PROJECT_ACCESS)[number];

const ACCESS_RANK: Record<string, number> = { all: 0, dev: 1, admin: 2, owner: 3 };

/** Whether `user` may open a project with this access. `role` null = nobody in particular: only 'all' projects. */
export function canAccess(user: { id: string | null; role: 'admin' | 'dev' | null }, access: string): boolean {
  const rank = user.id === null ? 3 : user.role === 'admin' ? 2 : user.role === 'dev' ? 1 : 0;
  return rank >= (ACCESS_RANK[access] ?? 3);
}
