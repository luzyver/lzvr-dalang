import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { git } from './git.js';
import { hasCodexHooks } from './code-memory.js';
import type { Backend } from './util.js';

/**
 * Impeccable's design detector (skills/impeccable), run as a hook in every turn that may edit files: after an edit of a
 * UI file it puts its findings in the agent's context, and at the end of the turn a deeper pass over every UI file the
 * turn touched. Both are what `npx impeccable install` sets up per project; here the shared skill folder serves every
 * project. The hook never blocks an edit and stays silent on files that are not UI.
 */
export interface DesignHookPolicy { enabled: boolean }
export const DESIGN_HOOK_DEFAULTS: DesignHookPolicy = { enabled: true };

const PER_EDIT_TIMEOUT_S = 5;
const DEEP_PASS_TIMEOUT_S = 30;
/** The detector's per-project state: written next to the code, kept out of the repository's changes. */
const CACHE = '.impeccable/hook.cache.json';

const slash = (p: string) => p.replace(/\\/g, '/');

/** The skill's launcher for this platform, or null when the skill is not there. */
export function launcher(skillsDir: string): string | null {
  const path = join(skillsDir, 'impeccable', 'scripts', process.platform === 'win32' ? 'impeccable.cmd' : 'impeccable');
  return existsSync(path) ? path : null;
}

/** Whether a folder already has Impeccable's hook installed itself (then that one runs, not ours as well). */
function installedIn(dir: string, backend: Backend): boolean {
  if (backend !== 'claude') return hasCodexHooks(dir);
  // Only a hook's command counts: a permission rule or note naming Impeccable installs nothing.
  type Settings = { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> };
  return ['settings.json', 'settings.local.json'].some((f) => {
    try {
      const s = JSON.parse(readFileSync(join(dir, '.claude', f), 'utf8')) as Settings;
      return Object.values(s.hooks ?? {}).some((list) => Array.isArray(list) && list.some((m) =>
        m?.hooks?.some((h) => typeof h?.command === 'string' && /impeccable/i.test(h.command))));
    } catch { return false; }
  });
}

/**
 * The CLI flags that add the hook to a turn, or null when it has none: off, no skill, or the folder brings its own.
 * Codex needs `--dangerously-bypass-hook-trust` (the caller checks this Codex knows it), so a folder with Codex hooks of
 * its own gets none from us, as with code memory's hook.
 */
export function designHookArgs(policy: DesignHookPolicy, skillsDir: string | undefined, backend: Backend, dirs: string[]): string[] | null {
  const path = policy.enabled && skillsDir ? launcher(skillsDir) : null;
  if (!path || dirs.some((d) => installedIn(d, backend))) return null;
  const p = slash(path);
  if (backend === 'claude') {
    // Windows: the .cmd launcher runs in PowerShell (Git Bash may be missing), where a quoted path needs the call operator.
    const shell = process.platform === 'win32' ? { shell: 'powershell', command: `& "${p}" hook` } : { command: `"${p}" hook` };
    const hook = (timeout: number, statusMessage: string) => [{ type: 'command', ...shell, timeout, statusMessage }];
    const settings = { hooks: {
      PostToolUse: [{ matcher: 'Edit|MultiEdit|Write', hooks: hook(PER_EDIT_TIMEOUT_S, 'Checking UI changes') }],
      Stop: [{ hooks: hook(DEEP_PASS_TIMEOUT_S, 'Design deep pass') }],
    } };
    return ['--settings', JSON.stringify(settings)];
  }
  // Codex runs a hook through the platform shell (PowerShell on Windows), where a quoted path needs the call operator.
  const command = /\s/.test(p) ? `${process.platform === 'win32' ? '& ' : ''}"${p}" hook` : `${p} hook`;
  // A JSON string is also a valid TOML basic string.
  const entry = (timeout: number) => `hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout}}]`;
  return ['--dangerously-bypass-hook-trust',
    '-c', `hooks.PostToolUse=[{matcher=${JSON.stringify('^(Edit|Write|apply_patch)$')},${entry(PER_EDIT_TIMEOUT_S)}}]`,
    '-c', `hooks.Stop=[{${entry(DEEP_PASS_TIMEOUT_S)}}]`];
}

/**
 * Two sets of hook flags as one: Claude Code takes a single `--settings`, so their hooks are merged into it; Codex's
 * trust flag is given once.
 */
export function mergeHookArgs(a: string[], b: string[]): string[] {
  const at = a.indexOf('--settings');
  const bt = b.indexOf('--settings');
  const out = [...a];
  const rest = [...b];
  if (at >= 0 && bt >= 0) {
    const sa = JSON.parse(a[at + 1]!) as { hooks?: Record<string, unknown[]> };
    const sb = JSON.parse(b[bt + 1]!) as { hooks?: Record<string, unknown[]> };
    const hooks = { ...sa.hooks };
    for (const [event, list] of Object.entries(sb.hooks ?? {})) hooks[event] = [...(hooks[event] ?? []), ...list];
    out[at + 1] = JSON.stringify({ ...sa, ...sb, hooks });
    rest.splice(bt, 2);
  }
  if (out.includes('--dangerously-bypass-hook-trust')) {
    const i = rest.indexOf('--dangerously-bypass-hook-trust');
    if (i >= 0) rest.splice(i, 1);
  }
  return [...out, ...rest];
}

/** Keeps the detector's cache out of the folder's git changes, locally (`info/exclude`): nothing to commit. */
export async function excludeCache(cwd: string): Promise<void> {
  try {
    const dir = (await git(cwd, ['rev-parse', '--git-common-dir'], 10_000)).trim();
    const file = join(isAbsolute(dir) ? dir : join(cwd, dir), 'info', 'exclude');
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { /* none yet */ }
    if (text.split(/\r?\n/).some((l) => l.trim() === CACHE || l.trim() === `/${CACHE}`)) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# Impeccable's design detector (Dalang)\n${CACHE}\n`);
  } catch { /* not a repository: nothing to keep out */ }
}
