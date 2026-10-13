import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insideRoot } from '../src/paths.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'lzvr-paths-')));
const root = join(base, 'root');
const outside = join(base, 'outside');
mkdirSync(join(root, 'a'), { recursive: true });
mkdirSync(outside);
writeFileSync(join(outside, 'secret.txt'), 'x');

describe('insideRoot', () => {
  it('accepts the root and children', () => {
    expect(insideRoot(root, '.')).toBe(root);
    expect(insideRoot(root, 'a')).toBe(join(root, 'a'));
    expect(insideRoot(root, join(root, 'a'))).toBe(join(root, 'a'));
  });

  it('rejects .. escapes, absolute outside paths and missing paths', () => {
    expect(insideRoot(root, '../outside')).toBeNull();
    expect(insideRoot(root, outside)).toBeNull();
    expect(insideRoot(root, 'does-not-exist')).toBeNull();
  });

  it('accepts any existing path when the root is the filesystem root', () => {
    const fsRoot = parse(base).root;
    expect(insideRoot(fsRoot, join(outside, 'secret.txt'))).toBe(join(outside, 'secret.txt'));
    expect(insideRoot(fsRoot, base)).toBe(base);
    expect(insideRoot(fsRoot, join(base, 'missing'))).toBeNull();
  });

  it('rejects a symlink that points outside', () => {
    symlinkSync(outside, join(root, 'link'), 'junction');
    expect(insideRoot(root, 'link')).toBeNull();
    expect(insideRoot(root, 'link/secret.txt')).toBeNull();
  });
});
