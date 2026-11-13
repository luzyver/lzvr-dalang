import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSkills, skillsGuide, SKILLS_DIR } from '../src/skills.js';

describe('Dalang skills', () => {
  it('reads each folder with a SKILL.md and skips the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lzvr-skills-'));
    mkdirSync(join(dir, 'b-skill'));
    writeFileSync(join(dir, 'b-skill', 'SKILL.md'), '---\r\nname: "bee"\r\ndescription: Does b things\r\nlicense: MIT\r\n---\r\n# B');
    mkdirSync(join(dir, 'a-skill'));
    writeFileSync(join(dir, 'a-skill', 'SKILL.md'), '---\ndescription: Does a things\n---\n');
    mkdirSync(join(dir, 'no-description'));
    writeFileSync(join(dir, 'no-description', 'SKILL.md'), '---\nname: x\n---\n');
    mkdirSync(join(dir, 'empty'));
    writeFileSync(join(dir, 'notes.md'), 'not a folder');
    const skills = loadSkills(dir);
    expect(skills.map((s) => [s.name, s.description])).toEqual([['a-skill', 'Does a things'], ['bee', 'Does b things']]);
    expect(skills[1]!.path).toBe(join(dir, 'b-skill', 'SKILL.md').replace(/\\/g, '/'));
  });

  it('joins a block scalar description into one line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lzvr-skills-'));
    mkdirSync(join(dir, 'folded'));
    writeFileSync(join(dir, 'folded', 'SKILL.md'), '---\nname: f\ndescription: >-\n  Does f things\n\n  when asked.\nlicense: MIT\n---\n');
    expect(loadSkills(dir).map((s) => s.description)).toEqual(['Does f things when asked.']);
  });

  it('has nothing to say without skills, and a missing folder is none', () => {
    expect(loadSkills(join(tmpdir(), 'lzvr-no-such-dir'))).toEqual([]);
    expect(skillsGuide([])).toBe('');
  });

  it('tells the agent to check them before its own', () => {
    const g = skillsGuide([{ name: 'bee', description: 'Does b things', path: '/s/bee/SKILL.md' }]);
    expect(g).toContain('Check them FIRST');
    expect(g).toContain('- bee (/s/bee/SKILL.md): Does b things');
  });

  it('ships diagram-design', () => {
    expect(loadSkills(SKILLS_DIR).map((s) => s.name)).toContain('diagram-design');
  });
});

import { customInvocation, customSkillPrompt } from '../src/skills.js';

describe('custom skills', () => {
  const skills = [{ name: 'Notes', description: '', content: 'Write notes.' }];
  it('finds a skill by name, ignoring case, only at the start of a prompt', () => {
    expect(customInvocation('/custom notes fix it', skills)).toMatchObject({ input: 'fix it', skill: { content: 'Write notes.' } });
    expect(customInvocation('please /custom notes', skills)).toBeNull();
    expect(customInvocation('/custom nope', skills)?.skill).toBeUndefined();
  });
  it('puts the instructions and the input in the prompt, which no longer starts with a slash', () => {
    const known = customSkillPrompt('/custom notes fix\nit', skills);
    expect(known).toContain('Write notes.');
    expect(known.endsWith('Input:\nfix\nit')).toBe(true);
    expect(customSkillPrompt('/custom notes', skills)).toContain('Input:\n(none)');
    const unknown = customSkillPrompt(' /custom nope x', skills);
    expect(unknown).toContain('no custom skill');
    expect(unknown).toContain('Notes');
    const bare = customSkillPrompt('/custom ', [{ name: 'Notes', description: 'Meeting notes', content: 'x' }]);
    expect(bare).toContain('- Notes: Meeting notes');
    for (const p of [known, unknown, bare]) expect(p.trimStart().startsWith('/')).toBe(false);
    expect(customSkillPrompt('/customs', skills)).toBe('/customs');
    expect(customSkillPrompt('/compact', skills)).toBe('/compact');
    expect(customSkillPrompt('hello', skills)).toBe('hello');
  });
});

import { AUTH } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

describe('custom skills API', () => {
  it('saves mixed-case names, rejects case-insensitive duplicates and non-admins', async () => {
    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    const put = (skills: unknown[], headers = AUTH) => t.app.inject({ method: 'PUT', url: '/api/settings/custom-skills', headers, payload: { skills } });
    expect((await put([{ name: 'Notes', description: 'd', content: 'x' }])).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/custom-skills', headers: AUTH })).json()).toEqual([{ name: 'Notes', description: 'd' }]);
    expect((await put([{ name: 'Notes', content: 'x' }, { name: 'notes', content: 'y' }])).statusCode).toBe(400);
    expect((await put([{ name: 'bad name', content: 'x' }])).statusCode).toBe(400);
    expect((await put([], bearer(dev.token))).statusCode).toBe(403);
    await t.app.close();
  });
});
