/**
 * Dalang's own skills (`skills/<name>/SKILL.md`, the Agent Skills format): offered to every turn, Codex and Claude Code
 * alike, ahead of the skills the agent's account has itself. The agent is told which there are and reads a skill's
 * SKILL.md only when its task fits, so a skill costs a turn its one-line description until then.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

export interface Skill { name: string; description: string; path: string }

/** The `key: value` lines of a SKILL.md's frontmatter (one-line values only, quotes dropped). */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  for (const line of m?.[1]?.split(/\r?\n/) ?? []) {
    const kv = /^([a-z_-]+):\s*(.*)$/i.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The skills in `dir`, read each turn so one added or changed needs no restart. A folder without a usable SKILL.md is skipped. */
export function loadSkills(dir: string = SKILLS_DIR): Skill[] {
  let names: string[];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  const skills: Skill[] = [];
  for (const folder of names) {
    const path = join(dir, folder, 'SKILL.md');
    let fm: Record<string, string>;
    try { fm = frontmatter(readFileSync(path, 'utf8')); } catch { continue; }
    if (fm.description) skills.push({ name: fm.name || folder, description: fm.description, path: path.replace(/\\/g, '/') });
  }
  return skills;
}

/** What a turn is told about Dalang's skills (empty when there are none). */
export function skillsGuide(skills: Skill[]): string {
  if (!skills.length) return '';
  return `Skills: Dalang has skills of its own. Check them FIRST, before your own skills (built-in, installed or plugin ones).
When the task fits one, read its SKILL.md before you start and follow it; paths in it are relative to its folder.
Only when none of these fits, look for one among your own skills.
These folders are shared by every chat: do not change files in them. Anything a skill would save in its own folder
(settings, a customized style guide) goes in the project instead, or ask the person.
${skills.map((s) => `- ${s.name} (${s.path}): ${s.description}`).join('\n')}`;
}
