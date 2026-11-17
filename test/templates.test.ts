import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { crc32 } from 'node:zlib';
// @ts-expect-error The panel modules are plain JavaScript.
import { MENTION, mentionKind, mentionText, menuItems } from '../public/js/mention-kinds.js';
import { isDocx, templateMentions, templatePrompt } from '../src/templates.js';
import { AUTH } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

/** A zip with stored (uncompressed) entries: what a .docx is, minus the compression. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(crc32(data), 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, data); central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const DOCX = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document>{{nama}}</w:document>' });

const templates = [{ name: 'penawaran', description: 'Surat penawaran', file: '/state/templates/penawaran.docx' }];

describe('templatePrompt', () => {
  it('finds mentions in either form, once each', () => {
    expect(templateMentions('buat @template:penawaran untuk PT A, @template penawaran lagi, @template:x', ['penawaran'])).toEqual(['penawaran', 'x']);
    expect(templateMentions('pakai @template Penawaran ya', ['penawaran'])).toEqual(['Penawaran']);
    expect(templateMentions('pakai @template untuk laporan', ['penawaran'])).toEqual([]); // a sentence about it, not a mention
    expect(templateMentions('mail me@template:x')).toEqual([]);
  });

  it('points the agent at the file, says when a name is unknown, leaves other prompts alone', () => {
    const p = templatePrompt('isi @template:Penawaran nama: PT A', templates);
    expect(p).toContain('/state/templates/penawaran.docx');
    expect(p).toContain('PDF');
    expect(templatePrompt('@template:nope x', templates)).toContain('no template of that name');
    expect(templatePrompt('@template ', templates)).toContain('- penawaran: Surat penawaran');
    for (const p of ['hello', 'ntar manggilnya pakai @template', 'tambah fitur @template di docs']) expect(templatePrompt(p, templates)).toBe(p);
  });
});

describe('isDocx', () => {
  it('accepts a Word zip and refuses other zips, truncated ones and plain bytes', () => {
    expect(isDocx(DOCX)).toBe(true);
    expect(isDocx(zip({ 'a.txt': 'x' }))).toBe(false);
    expect(isDocx(DOCX.subarray(0, DOCX.length - 10))).toBe(false);
    expect(isDocx(Buffer.from('PKxx'))).toBe(false);
  });
});

describe('composer @ menu', () => {
  it('opens the template list for @template and inserts @template:<name>', () => {
    const m = 'make a pdf @template:pen'.match(MENTION);
    expect(m?.[2]).toBe('template');
    expect(m?.[3]).toBe('pen');
    const kind = mentionKind(m![2]!.toLowerCase(), false);
    expect(kind).toBe('template');
    expect(menuItems(kind, [{ name: 'penawaran', description: 'Surat' }])).toEqual([{ id: 'penawaran', label: 'penawaran', note: 'Surat' }]);
    expect(mentionText(kind, 'penawaran')).toBe('@template:penawaran ');
    expect(mentionKind('db', false)).toBe('db');
    expect(mentionKind('ssh', false)).toBe('ssh');
  });
});

describe('templates API', () => {
  it('rejects non-docx uploads and non-admins, lists and removes templates', async () => {
    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    const boundary = 'xBOUNDARYx';
    const body = (filename: string, data: string | Buffer, name: string) => Buffer.concat([Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\nd\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const put = (filename: string, data: string | Buffer, headers = AUTH, name = 'surat') => t.app.inject({
      method: 'PUT', url: '/api/settings/templates', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body(filename, data, name),
    });
    expect((await put('a.txt', 'PKxx')).statusCode).toBe(400);
    expect((await put('a.docx', 'nope')).statusCode).toBe(400);
    expect((await put('a.docx', 'PKxx')).statusCode).toBe(400);
    expect((await put('a.docx', DOCX, bearer(dev.token))).statusCode).toBe(403);
    expect((await put('a.docx', DOCX)).statusCode).toBe(204);
    expect((await put('a.docx', DOCX.subarray(0, 40))).statusCode).toBe(400); // a broken upload must not replace the good one
    expect(readFileSync(t.store.getTemplates()[0]!.file).equals(DOCX)).toBe(true);
    // The same name in other letter case replaces it: one template, one file, holding the newer upload.
    const newer = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document>{{baru}}</w:document>' });
    const old = t.store.getTemplates()[0]!.file;
    expect((await put('a.docx', newer, AUTH, 'Surat')).statusCode).toBe(204);
    expect(t.store.getTemplates().map((x) => x.name)).toEqual(['Surat']);
    expect(readFileSync(t.store.getTemplates()[0]!.file).equals(newer)).toBe(true);
    expect(readdirSync(dirname(old))).toHaveLength(1);
    expect((await put('a.docx', DOCX)).statusCode).toBe(204);
    expect(readFileSync(t.store.getTemplates()[0]!.file).equals(DOCX)).toBe(true);
    expect((await t.app.inject({ url: '/api/templates', headers: AUTH })).json()).toEqual([{ name: 'surat', description: 'd' }]);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/settings/templates/surat', headers: AUTH })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/templates', headers: AUTH })).json()).toEqual([]);
    await t.app.close();
  });
});
