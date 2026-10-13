import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSessions } from '../src/sessions.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

function rollout(home: string, day: string, ts: string, id: string, firstLine: string, mtime: number) {
  const dir = join(home, 'sessions', ...day.split('/'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${ts}-${id}.jsonl`);
  writeFileSync(file, firstLine + '\n{"type":"other"}\n');
  utimesSync(file, mtime, mtime);
}

describe('listSessions', () => {
  it('lists rollout files newest first with their cwd when readable', () => {
    const home = mkdtempSync(join(tmpdir(), 'lzvr-sess-'));
    rollout(home, '2026/10/12', '2026-10-12T09-00-00', A, JSON.stringify({ type: 'session_meta', payload: { id: A, cwd: '/w/old' } }), 1000);
    rollout(home, '2026/10/13', '2026-10-13T10-00-00', B, 'not json at all', 2000);
    writeFileSync(join(home, 'sessions', 'README.txt'), 'ignore me');

    const out = listSessions(home);

    expect(out.map((s) => s.id)).toEqual([B, A]);
    expect(out[0]).toMatchObject({ id: B, cwd: null });
    expect(out[1]).toMatchObject({ id: A, cwd: '/w/old' });
    expect(out[0]!.modified).toBeGreaterThan(out[1]!.modified);
  });

  it('returns an empty list when there is no sessions directory', () => {
    expect(listSessions(mkdtempSync(join(tmpdir(), 'lzvr-sess-')))).toEqual([]);
  });

  it('honours the limit', () => {
    const home = mkdtempSync(join(tmpdir(), 'lzvr-sess-'));
    rollout(home, '2026/10/12', '2026-10-12T09-00-00', A, '{}', 1000);
    rollout(home, '2026/10/13', '2026-10-13T10-00-00', B, '{}', 2000);
    expect(listSessions(home, 1).map((s) => s.id)).toEqual([B]);
  });
});
