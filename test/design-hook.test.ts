import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { designHookArgs, excludeCache, mergeHookArgs } from '../src/design-hook.js';

function skills(): string {
  const dir = mkdtempSync(join(tmpdir(), 'design-skills-'));
  mkdirSync(join(dir, 'impeccable', 'scripts'), { recursive: true });
  for (const f of ['impeccable', 'impeccable.cmd']) writeFileSync(join(dir, 'impeccable', 'scripts', f), '');
  return dir;
}
const project = () => mkdtempSync(join(tmpdir(), 'design-project-'));

describe('design hook', () => {
  it('gives Claude Code a per-edit and a Stop hook, and nothing when off or without the skill', () => {
    const args = designHookArgs({ enabled: true }, skills(), 'claude', [project()])!;
    expect(args[0]).toBe('--settings');
    const s = JSON.parse(args[1]!) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    expect(s.hooks.PostToolUse![0]!.matcher).toBe('Edit|MultiEdit|Write');
    expect(s.hooks.Stop![0]!.hooks[0]!.command).toMatch(/impeccable(\.cmd)?" hook$/);
    expect(designHookArgs({ enabled: false }, skills(), 'claude', [project()])).toBeNull();
    expect(designHookArgs({ enabled: true }, project(), 'claude', [project()])).toBeNull();
    expect(designHookArgs({ enabled: true }, undefined, 'claude', [project()])).toBeNull();
  });

  it('gives Codex inline hooks behind the trust flag, and none to a folder with hooks of its own', () => {
    const args = designHookArgs({ enabled: true }, skills(), 'codex', [project()])!;
    expect(args[0]).toBe('--dangerously-bypass-hook-trust');
    expect(args.filter((a) => a.startsWith('hooks.')).map((a) => a.split('=')[0])).toEqual(['hooks.PostToolUse', 'hooks.Stop']);
    const own = project();
    mkdirSync(join(own, '.codex'));
    writeFileSync(join(own, '.codex', 'hooks.json'), '{}');
    expect(designHookArgs({ enabled: true }, skills(), 'codex', [own])).toBeNull();
  });

  it('skips a project that installed Impeccable for Claude Code itself', () => {
    const own = project();
    mkdirSync(join(own, '.claude'));
    writeFileSync(join(own, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'impeccable hook' }] }] } }));
    expect(designHookArgs({ enabled: true }, skills(), 'claude', [own])).toBeNull();
    const named = project();
    mkdirSync(join(named, '.claude'));
    writeFileSync(join(named, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(impeccable *)'] } }));
    writeFileSync(join(named, '.claude', 'settings.local.json'), '{ not json');
    expect(designHookArgs({ enabled: true }, skills(), 'claude', [named])).not.toBeNull();
  });

  it('merges two --settings into one and gives the trust flag once', () => {
    const a = ['--settings', JSON.stringify({ hooks: { PreToolUse: [1], PostToolUse: [2] } })];
    const b = ['--settings', JSON.stringify({ hooks: { PostToolUse: [3], Stop: [4] } })];
    const m = mergeHookArgs(a, b);
    expect(m.length).toBe(2);
    expect(JSON.parse(m[1]!)).toEqual({ hooks: { PreToolUse: [1], PostToolUse: [2, 3], Stop: [4] } });
    const c = mergeHookArgs(['--dangerously-bypass-hook-trust', '-c', 'x=1'], ['--dangerously-bypass-hook-trust', '-c', 'y=2']);
    expect(c).toEqual(['--dangerously-bypass-hook-trust', '-c', 'x=1', '-c', 'y=2']);
  });

  it('keeps the cache out of git changes once', async () => {
    const repo = project();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await excludeCache(repo);
    await excludeCache(repo);
    const text = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(text.split('\n').filter((l) => l === '.impeccable/hook.cache.json')).toHaveLength(1);
    await excludeCache(project()); // not a repository: nothing happens
  });
});
