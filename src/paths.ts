import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Real path of `p` if it exists and lies inside `root` (symlinks resolved), else null. */
export function insideRoot(root: string, p: string): string | null {
  try {
    const r = realpathSync(root);
    const t = realpathSync(resolve(r, p));
    const rel = relative(r, t);
    const escapes = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
    return escapes ? null : t;
  } catch {
    return null;
  }
}
