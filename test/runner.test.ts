import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runClaudeTurn } from '../src/claude.js';
import { buildArgs, runTurn, type TurnOpts } from '../src/codex.js';
import { inheritedEnv, type CodexEvent } from '../src/runner.js';
import { FAKE } from './helpers.js';

const FAKE_CLAUDE = [process.execPath, fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))];

const dir = mkdtempSync(join(tmpdir(), 'lzvr-run-'));
const base = { command: FAKE, home: dir, cwd: dir, sandbox: 'workspace-write' };

async function collect(o: Partial<TurnOpts> & { prompt: string }): Promise<CodexEvent[]> {
  const out: CodexEvent[] = [];
  for await (const e of runTurn({ ...base, ...o })) out.push(e);
  return out;
}

describe('inheritedEnv', () => {
  it('keeps the server environment but none of its own LZVR_ secrets', () => {
    process.env.LZVR_TEST_SECRET = 'x';
    process.env.TEST_PLAIN = 'y';
    try {
      const env = inheritedEnv();
      expect(env.TEST_PLAIN).toBe('y');
      expect(Object.keys(env).filter((k) => k.startsWith('LZVR_'))).toEqual([]);
    } finally { delete process.env.LZVR_TEST_SECRET; delete process.env.TEST_PLAIN; }
  });
});

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

  it('kills a process that stays alive after turn.completed, without reporting it as a failure', async () => {
    const start = Date.now();
    const ev = await collect({ prompt: 'x', env: { FAKE_MODE: 'linger' }, exitGraceMs: 300 });
    expect(ev.at(-1)?.type).toBe('turn.completed');
    expect(ev.map((e) => e.type)).not.toContain('process.exit');
    expect(Date.now() - start).toBeLessThan(10000);
  });

  it('ends a cancelled run even when an orphaned grandchild still holds its output open', async () => {
    const pidFile = join(dir, 'orphan.pid');
    const ac = new AbortController();
    const start = Date.now();
    let last: CodexEvent | undefined;
    try {
      for await (const e of runTurn({
        ...base, prompt: 'x', env: { FAKE_MODE: 'orphan', FAKE_ORPHAN_PID: pidFile }, signal: ac.signal, killGraceMs: 200,
      })) {
        last = e;
        if (e.type === 'turn.started') {
          while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
          ac.abort();
        }
      }
      expect(last?.type).toBe('process.exit');
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch { /* already gone */ }
    }
  });

  it('ends a turn whose CLI died while an orphaned grandchild still holds its output open', async () => {
    const pidFile = join(dir, 'orphan-exit.pid');
    const start = Date.now();
    try {
      const ev = await collect({ prompt: 'x', env: { FAKE_MODE: 'orphan-exit', FAKE_ORPHAN_PID: pidFile }, drainGraceMs: 300 });
      expect(ev.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'process.exit']);
      expect(ev.at(-1)).toMatchObject({ code: 3 });
      expect(Date.now() - start).toBeLessThan(8000);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch { /* already gone */ }
    }
  });

  it('stops reading at most 5 drain graces after the CLI died, also while its orphan keeps writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lzvr-chatty-'));
    const pidFile = join(dir, 'orphan-chatty.pid');
    const start = Date.now();
    try {
      const ev = await collect({ prompt: 'x', env: { FAKE_MODE: 'orphan-chatty', FAKE_ORPHAN_PID: pidFile }, drainGraceMs: 300 }); // cap: 5 × 300ms after exit
      expect(ev.at(-1)).toMatchObject({ type: 'process.exit', code: 3 });
      expect(ev.some((e) => e.type === 'raw')).toBe(true); // what it wrote until then still came through
      expect(Date.now() - start).toBeLessThan(6000);
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8'))); } catch { /* already gone */ }
    }
  });

  it('keeps every line a CLI printed right before exiting, even for a slow reader', async () => {
    let lines = 0;
    for await (const e of runTurn({ ...base, prompt: 'x', env: { FAKE_MODE: 'flush' }, drainGraceMs: 1 })) {
      if (String((e.item as { text?: string } | undefined)?.text).startsWith('line ')) lines++;
      if (lines % 200 === 1) await new Promise((r) => setTimeout(r, 20)); // the dispatcher writing to the store
    }
    expect(lines).toBe(2000);
  });
});

describe('runClaudeTurn', () => {
  it("kills Claude Code when it stays alive after its result, without reporting it as a failure", async () => {
    const start = Date.now();
    const ev: CodexEvent[] = [];
    for await (const e of runClaudeTurn({ command: FAKE_CLAUDE, home: dir, cwd: dir, sandbox: 'read-only', prompt: 'x',
      env: { FAKE_MODE: 'linger' }, exitGraceMs: 300 })) ev.push(e);
    expect(ev.at(-1)?.type).toBe('turn.completed');
    expect(ev.map((e) => e.type)).not.toContain('process.exit');
    expect(Date.now() - start).toBeLessThan(10000);
  });
});
