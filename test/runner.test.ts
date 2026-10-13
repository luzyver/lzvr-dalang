import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArgs, runTurn, type TurnOpts } from '../src/codex.js';
import type { CodexEvent } from '../src/runner.js';
import { FAKE } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'lzvr-run-'));
const base = { command: FAKE, home: dir, cwd: dir, sandbox: 'workspace-write' };

async function collect(o: Partial<TurnOpts> & { prompt: string }): Promise<CodexEvent[]> {
  const out: CodexEvent[] = [];
  for await (const e of runTurn({ ...base, ...o })) out.push(e);
  return out;
}

describe('buildArgs', () => {
  it('builds a fresh run', () => {
    expect(buildArgs({ cwd: '/w', sandbox: 'workspace-write' })).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-C', '/w', '-s', 'workspace-write', '-',
    ]);
  });

  it('inserts extra config overrides before resume', () => {
    expect(buildArgs({ cwd: '/w', sandbox: 'read-only', threadId: 't', extraArgs: ['-c', 'a=1'] })).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-C', '/w', '-s', 'read-only', '-c', 'a=1', 'resume', 't', '-',
    ]);
  });

  it('puts images first and adds resume before the stdin marker', () => {
    expect(buildArgs({ cwd: '/w', sandbox: 'read-only', threadId: 'tid', images: ['a.png', 'b.png'] })).toEqual([
      'exec', '-i', 'a.png', '-i', 'b.png', '--json', '--skip-git-repo-check', '-C', '/w', '-s', 'read-only',
      'resume', 'tid', '-',
    ]);
  });
});

describe('runTurn', () => {
  it('yields parsed events from a fresh run', async () => {
    const ev = await collect({ prompt: 'hi' });
    expect(ev.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
    expect(String(ev[0]!.thread_id)).toMatch(/^thread-/);
  });

  it('resumes an existing thread', async () => {
    const ev = await collect({ prompt: 'hi', threadId: 'abc' });
    expect(ev[0]).toMatchObject({ type: 'thread.started', thread_id: 'abc' });
  });

  it('passes awkward prompts through stdin intact', async () => {
    const prompt = '-rf "quoted" \'single\'\nline2 \u{1F600} $HOME `x`';
    const ev = await collect({ prompt });
    const msg = ev.find((e) => e.type === 'item.completed') as unknown as { item: { text: string; args: string[] } };
    expect(msg.item.text).toBe(prompt);
    expect(msg.item.args).not.toContain(prompt);
  });

  it('reports a non-zero exit after turn.failed', async () => {
    const ev = await collect({ prompt: 'x', env: { FAKE_MODE: 'fail' } });
    expect(ev.map((e) => e.type)).toContain('turn.failed');
    expect(ev.at(-1)).toMatchObject({ type: 'process.exit', code: 1 });
  });

  it('reports a missing binary as process.exit instead of hanging or throwing', async () => {
    const ev = await collect({ prompt: 'x', command: ['lzvr-no-such-binary'] });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'process.exit', code: -1 });
  });

  it('stops the process when the signal aborts', async () => {
    const ac = new AbortController();
    const ev: CodexEvent[] = [];
    for await (const e of runTurn({ ...base, prompt: 'x', env: { FAKE_MODE: 'slow' }, signal: ac.signal })) {
      ev.push(e);
      if (e.type === 'turn.started') ac.abort();
    }
    expect(ev.at(-1)?.type).toBe('process.exit');
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const ac = new AbortController();
    const start = Date.now();
    let last: CodexEvent | undefined;
    for await (const e of runTurn({
      ...base, prompt: 'x', env: { FAKE_MODE: 'stubborn' }, signal: ac.signal, killGraceMs: 200,
    })) {
      last = e;
      if (e.type === 'turn.started') ac.abort();
    }
    expect(last?.type).toBe('process.exit');
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
