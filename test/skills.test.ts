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
