import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capDiff, codexDiffs, rolloutFileChanges, wholeFile } from '../src/diff.js';

const fileChange = (id: string, at: number, changes: Record<string, unknown>) => JSON.stringify({
  type: 'event_msg', payload: { type: 'item_completed', completed_at_ms: at, item: { type: 'FileChange', id, changes } },
});

describe('codex diffs from the rollout', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'lzvr-diff-')), 'rollout.jsonl');
  writeFileSync(file, [
    fileChange('old', 1000, { 'C:\\w\\a.txt': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y\n' } }),
    '{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage"}}}',
    fileChange('new', 5000, {
      'C:\\w\\a.txt': { type: 'update', unified_diff: '@@ -1,2 +1,2 @@\n a\n-b\n+B\n', move_path: null },
      'C:\\w\\b.txt': { type: 'add', content: 'hi\n' },
      'C:\\w\\c.txt': { type: 'delete', content: 'bye\n' },
    }),
    'cut off {"FileChange"',
  ].join('\n'));

  it('matches the entry with the same files, once, ignoring older turns', () => {
    const entries = rolloutFileChanges(file, 2000);
    expect(entries.map((e) => e.id)).toEqual(['new']);
    const used = new Set<string>();
    const changes = [{ path: 'C:/w/A.txt', kind: 'update' }, { path: 'C:\\w\\b.txt', kind: 'add' }, { path: 'C:\\w\\c.txt', kind: 'delete' }];
    expect(codexDiffs(changes, entries, used)).toEqual([
      { path: 'C:/w/A.txt', kind: 'update', diff: '@@ -1,2 +1,2 @@\n a\n-b\n+B' },
      { path: 'C:\\w\\b.txt', kind: 'add', diff: '@@ -0,0 +1,1 @@\n+hi' },
      { path: 'C:\\w\\c.txt', kind: 'delete', diff: '@@ -1,1 +0,0 @@\n-bye' },
    ]);
    expect(codexDiffs(changes, entries, used)).toBeNull(); // already used
    expect(codexDiffs([{ path: 'C:\\w\\a.txt', kind: 'update' }], entries, new Set())).toBeNull(); // different file set
  });

  it('caps huge diffs and handles empty files', () => {
    expect(wholeFile('', '+')).toBe('');
    const big = capDiff(`@@ -1 +1 @@\n${'+x\n'.repeat(40000)}`);
    expect(big.length).toBeLessThan(70000);
    expect(big.endsWith('… diff truncated')).toBe(true);
  });
});
