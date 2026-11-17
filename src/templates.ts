/**
 * Document templates: a Word file (.docx) an admin uploads in Settings, with the fields to fill written in it as
 * placeholders (`{{field}}`, `[Field]`, whatever the template uses). A prompt that mentions `@template:<name>` has the agent fill that
 * file from the rest of the message and hand back a PDF (see templatePrompt).
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A template: its .docx lives on disk at `file` (inside the state folder); this record is what the database keeps. */
export interface Template { name: string; description: string; file: string }

/** Where a chat's agent fills templates: the copy and the PDF are made here, outside the project, so they never show up in its changes. */
export const templateWorkDir = (convId: string) => join(tmpdir(), 'dalang-template', convId);

export const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// "@template:name" anywhere in a prompt (what the composer's menu writes), or "@template name".
const MENTION = /(^|\s)@template(:|\s+)([\w-]+)/gi;

/**
 * The names a prompt mentions with `@template`, in order, once each, as typed. "@template:name" always counts, so a
 * mistyped name is answered; "@template name" only when `name` is one of `known`: a sentence about "@template" is not a mention.
 */
export function templateMentions(prompt: string, known: string[] = []): string[] {
  const names = new Set(known.map((n) => n.toLowerCase()));
  const seen = new Map<string, string>();
  for (const m of prompt.matchAll(MENTION)) {
    const key = m[3]!.toLowerCase();
    if ((m[2] === ':' || names.has(key)) && !seen.has(key)) seen.set(key, m[3]!);
  }
  return [...seen.values()];
}

/** The templates a prompt mentions, for the folders the agent must be able to read. */
export function mentionedTemplates(prompt: string, templates: Template[]): Template[] {
  const names = templateMentions(prompt, templates.map((t) => t.name)).map((n) => n.toLowerCase());
  return templates.filter((t) => names.includes(t.name.toLowerCase()));
}

/**
 * Whether `bytes` is a Word document: a zip whose central directory lists [Content_Types].xml and word/document.xml.
 * Read from the directory at the end of the file, so a truncated or random upload fails here, not when an agent opens it.
 */
export function isDocx(bytes: Buffer): boolean {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return false;
  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  const names = new Set<string>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return false;
    const nameLen = bytes.readUInt16LE(at + 28);
    const extraLen = bytes.readUInt16LE(at + 30);
    const commentLen = bytes.readUInt16LE(at + 32);
    const localAt = bytes.readUInt32LE(at + 42);
    if (at + 46 + nameLen > bytes.length || localAt + 30 > bytes.length || bytes.readUInt32LE(localAt) !== 0x04034b50) return false;
    names.add(bytes.toString('utf8', at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names.has('[Content_Types].xml') && names.has('word/document.xml');
}

/**
 * The prompt the agent gets: what was typed, then what to do with each template it mentions (where the .docx is and how
 * to turn it into a PDF), or that there is no such template. "@template" alone lists them. Any other prompt comes back
 * unchanged, also one that only talks about "@template". `workDir` is the folder the agent works in (templateWorkDir).
 */
export function templatePrompt(prompt: string, templates: Template[], workDir: string): string {
  const names = templateMentions(prompt, templates.map((t) => t.name));
  if (!names.length) {
    if (prompt.trim().toLowerCase() !== '@template') return prompt;
    const list = templates.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n') || '(none yet: an admin adds them in Settings)';
    return `${prompt}\n\nThe person typed "@template" without the name of a template. Do nothing else: show them this list and say one is used with "@template:<name>".\n\n${list}`;
  }
  const parts = names.map((name) => {
    const t = templates.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!t) {
      const known = templates.map((x) => x.name).join(', ') || 'none';
      return `Template "${name}": there is no template of that name (there are: ${known}). Tell the person so and do not guess its content.`;
    }
    return `Template "${t.name}"${t.description ? ` (${t.description})` : ''}: ${t.file}`;
  });
  return `${prompt}

The person asked for a PDF made from a document template (a Word file). Use the person's message above as the data to fill in.
${parts.join('\n')}

How to do it:
1. Copy the template .docx into ${workDir} (a new file; never change the original, it is shared by every chat) and open
   the copy. Everything you make for this (the copy, the PDF, any helper file) goes in that folder, not in the project.
2. Find its fields: placeholders such as {{field}} or [Field], in the body and in headers, footers and tables. Word often
   splits one placeholder over several runs, so look at the text of a paragraph, not at single runs. Fill each from the
   message and keep the template's layout and formatting. A field the message gives no value for: ask the person, do
   not invent one.
3. Check the filled copy: no placeholder left anywhere (headers and footers too), headings numbered in order, and the
   table of contents, if there is one, updated.
4. Convert the filled copy to PDF (for example \`soffice --headless --convert-to pdf --outdir <folder> <file>.docx\`).
   If no converter is installed, say so and give the filled .docx instead.
5. Tell the person the path of the PDF (and of the .docx) you made.`;
}
