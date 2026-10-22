/**
 * Downloads of every row a statement returns, written as they are read (see streamStatement): CSV, TSV, Excel, JSON,
 * JSON Lines, SQL INSERT statements, Markdown and HTML, the same files the panel builds for the rows it holds
 * (public/js/sql-export.js).
 */
import type { Writable } from 'node:stream';
import { constants, crc32, createDeflateRaw } from 'node:zlib';
import type { Column, Driver, RowSink } from './databases.js';

export const EXPORT_FORMATS = ['csv', 'tsv', 'xlsx', 'json', 'jsonl', 'sql', 'md', 'html'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];
export interface ExportCtx { driver: Driver; table?: { schema: string; table: string } | null; sheet?: string }

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8', tsv: 'text/tab-separated-values; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8', sql: 'application/sql; charset=utf-8', md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
};
/** Excel's last row is 1 048 576: the header and this many rows. */
export const XLSX_MAX_ROWS = 1_048_575;

const csvCell = (v: unknown) => (v === null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const tsvCell = (v: unknown) => (v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const my = (driver: Driver) => driver === 'mysql' || driver === 'mariadb';

function literal(v: unknown, driver: Driver): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${v}'`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = String(v).replace(/'/g, '\'\'');
  return `'${my(driver) ? s.replace(/\\/g, '\\\\') : s}'`;
}
const ident = (name: string, driver: Driver) => (my(driver) ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`);

/** A text format: what comes before the rows, each row (`first`: the first one), and what ends the file. */
interface TextFormat { bom?: boolean; head(cols: Column[]): string; row(row: unknown[], first: boolean): string; tail(any: boolean): string }

function textFormat(format: Exclude<ExportFormat, 'xlsx'>, ctx: ExportCtx): TextFormat {
  let names: string[] = [];
  const object = (row: unknown[]) => Object.fromEntries(names.map((n, i) => [n, row[i]]));
  switch (format) {
    // A CSV starts with a byte order mark: Excel reads it as UTF-8 then.
    case 'csv': return { bom: true, head: (c) => c.map((x) => csvCell(x.name)).join(','), row: (r) => `\r\n${r.map(csvCell).join(',')}`, tail: () => '' };
    case 'tsv': return { head: (c) => c.map((x) => tsvCell(x.name)).join('\t'), row: (r) => `\n${r.map(tsvCell).join('\t')}`, tail: () => '' };
    case 'json': return {
      head: (c) => { names = c.map((x) => x.name); return '['; },
      row: (r, first) => `${first ? '' : ','}\n  ${JSON.stringify(object(r), null, 2).replace(/\n/g, '\n  ')}`,
      tail: (any) => (any ? '\n]' : ']'),
    };
    case 'jsonl': return { head: (c) => { names = c.map((x) => x.name); return ''; }, row: (r, first) => `${first ? '' : '\n'}${JSON.stringify(object(r))}`, tail: () => '' };
    case 'sql': {
      const { driver, table } = ctx;
      const target = table ? (table.schema && driver !== 'sqlite' ? `${ident(table.schema, driver)}.${ident(table.table, driver)}` : ident(table.table, driver)) : ident('result', driver);
      let cols = '';
      return {
        head: (c) => { cols = c.map((x) => ident(x.name, driver)).join(', '); return ''; },
        row: (r, first) => `${first ? '' : '\n'}INSERT INTO ${target} (${cols}) VALUES (${r.map((v) => literal(v, driver)).join(', ')});`,
        tail: () => '',
      };
    }
    case 'md': {
      const cell = (v: unknown) => (v === null ? 'NULL' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'));
      return {
        head: (c) => `| ${c.map((x) => cell(x.name)).join(' | ')} |\n| ${c.map(() => '---').join(' | ')} |`,
        row: (r) => `\n| ${r.map(cell).join(' | ')} |`, tail: () => '',
      };
    }
    case 'html': return {
      head: (c) => `<!doctype html>\n<meta charset="utf-8">\n<table border="1" cellspacing="0" cellpadding="4">\n<thead><tr>${c.map((x) => `<th>${esc(x.name)}</th>`).join('')}</tr></thead>\n<tbody>`,
      row: (r) => `\n<tr>${r.map((v) => (v === null ? '<td><i>NULL</i></td>' : `<td>${esc(v)}</td>`)).join('')}</tr>`,
      tail: () => '\n</tbody>\n</table>\n',
    };
  }
}

/** Writes to `out`, waiting while it is full; fails once it is closed (the download was cancelled). */
class Out {
  bytes = 0;
  constructor(private out: Writable) {}
  async write(chunk: Buffer | string): Promise<void> {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (!buf.length) return;
    if (this.out.destroyed || this.out.writableEnded) throw new Error('the download was closed');
    this.bytes += buf.length;
    if (!this.out.write(buf)) await this.drained();
  }
  drained(): Promise<void> {
    return new Promise((res, rej) => {
      const done = () => { this.out.off('drain', done); this.out.off('close', closed); res(); };
      const closed = () => { this.out.off('drain', done); rej(new Error('the download was closed')); };
      this.out.once('drain', done);
      this.out.once('close', closed);
    });
  }
}

// ---------- .xlsx: a zip written as it goes ----------

const dosDate = 0x21; // 1980-01-01, no time
interface ZipEntry { name: Buffer; crc: number; csize: number; usize: number; offset: number; method: number; flags: number }

function localHeader(name: Buffer, method: number, flags: number, crc: number, csize: number, usize: number): Buffer {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(method, 8);
  h.writeUInt16LE(0, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(csize, 18); h.writeUInt32LE(usize, 22);
  h.writeUInt16LE(name.length, 26);
  return Buffer.concat([h, name]);
}
function centralEntry(e: ZipEntry): Buffer {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(e.flags, 8); h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(0, 12); h.writeUInt16LE(dosDate, 14); h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(e.csize, 20); h.writeUInt32LE(e.usize, 24);
  h.writeUInt16LE(e.name.length, 28); h.writeUInt32LE(e.offset, 42);
  return Buffer.concat([h, e.name]);
}

const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// Characters XML 1.0 cannot hold go; Excel also stops a cell at 32 767 characters.
const xmlText = (v: unknown) => esc(String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').slice(0, 32767));
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const STATIC_PARTS = (sheet: string): [string, string][] => [
  ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
  ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
  ['xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ['xl/styles.xml', `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
];
/** A zip entry's sizes are 32-bit (no zip64 here): the sheet stops short of 4 GiB. */
const ZIP_MAX = 0xffff_0000;

/**
 * A .xlsx written as rows come: the small parts stored, then the sheet deflated as it is written (its sizes and CRC in
 * a data descriptor after it), then the central directory. Stops at Excel's last row (or a 4 GiB sheet).
 */
function xlsxSink(out: Out, ctx: ExportCtx): RowSink & { end(): Promise<void>; cut: boolean; count(): number } {
  const entries: ZipEntry[] = [];
  const sheetName = xmlText((ctx.sheet || 'Result').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Result');
  const deflate = createDeflateRaw({ level: constants.Z_BEST_SPEED });
  let crc = 0;
  let usize = 0;
  let csize = 0;
  let y = 0;
  let sheet: ZipEntry | null = null;
  let pending: Promise<void> = Promise.resolve();
  // Compressed bytes go out in order, each after the one before.
  deflate.on('data', (chunk: Buffer) => {
    csize += chunk.length;
    pending = pending.then(() => out.write(chunk));
    pending.catch(() => {}); // awaited by the next feed or end; not unhandled meanwhile
  });
  const feed = async (text: string) => {
    const buf = Buffer.from(text, 'utf8');
    crc = crc32(buf, crc);
    usize += buf.length;
    if (!deflate.write(buf)) await new Promise((res) => deflate.once('drain', res));
    await pending;
  };
  const cell = (v: unknown, ref: string, style: string) => {
    if (v === null) return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"${style}><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
  };
  const row = (r: unknown[], style: string) => { y++; return `<row r="${y}">${r.map((v, x) => cell(v, `${colName(x)}${y}`, style)).join('')}</row>`; };
  const sink = {
    cut: false,
    count: () => Math.max(0, y - 1),
    async columns(cols: Column[]) {
      for (const [name, text] of STATIC_PARTS(sheetName)) {
        const data = Buffer.from(text, 'utf8');
        const e: ZipEntry = { name: Buffer.from(name), crc: crc32(data), csize: data.length, usize: data.length, offset: out.bytes, method: 0, flags: 0x0800 };
        await out.write(localHeader(e.name, 0, e.flags, e.crc, data.length, data.length));
        await out.write(data);
        entries.push(e);
      }
      // Bit 3: the sizes and CRC follow the data.
      sheet = { name: Buffer.from('xl/worksheets/sheet1.xml'), crc: 0, csize: 0, usize: 0, offset: out.bytes, method: 8, flags: 0x0808 };
      await out.write(localHeader(sheet.name, 8, sheet.flags, 0, 0, 0));
      await feed(`${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${row(cols.map((c) => c.name), ' s="1"')}`);
    },
    async rows(rows: unknown[][]) {
      let text = '';
      for (const r of rows) {
        if (y > XLSX_MAX_ROWS) { sink.cut = true; break; }
        const next = row(r, '');
        if (usize + text.length * 3 + next.length * 3 > ZIP_MAX) { sink.cut = true; break; }
        text += next;
      }
      await feed(text);
      return !sink.cut;
    },
    async end() {
      await feed('</sheetData></worksheet>');
      await new Promise<void>((res, rej) => { deflate.once('end', res); deflate.once('error', rej); deflate.end(); });
      await pending;
      Object.assign(sheet!, { crc, csize, usize });
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(csize, 8); desc.writeUInt32LE(usize, 12);
      await out.write(desc);
      entries.push(sheet!);
      const at = out.bytes;
      const central = Buffer.concat(entries.map(centralEntry));
      await out.write(central);
      const endRec = Buffer.alloc(22);
      endRec.writeUInt32LE(0x06054b50, 0); endRec.writeUInt16LE(entries.length, 8); endRec.writeUInt16LE(entries.length, 10);
      endRec.writeUInt32LE(central.length, 12); endRec.writeUInt32LE(at, 16);
      await out.write(endRec);
    },
  };
  return sink;
}

/**
 * Where streamStatement's rows go to become a `format` file on `out`. `end()` finishes the file (after the last row);
 * `rowCount()` is how many rows it holds; `cut()`: rows were left out (Excel's last row).
 */
export function exportSink(format: ExportFormat, ctx: ExportCtx, out: Writable): RowSink & { end(): Promise<void>; rowCount(): number; cut(): boolean } {
  const o = new Out(out);
  if (format === 'xlsx') {
    const x = xlsxSink(o, ctx);
    return { columns: (c) => x.columns(c), rows: (rows) => x.rows(rows), end: () => x.end(), rowCount: () => x.count(), cut: () => x.cut };
  }
  let count = 0;
  const f = textFormat(format, ctx);
  return {
    async columns(cols) { await o.write(`${f.bom ? '﻿' : ''}${f.head(cols)}`); },
    async rows(rows) {
      let text = '';
      for (const r of rows) { text += f.row(r, count === 0); count++; }
      await o.write(text);
      return true;
    },
    end: () => o.write(f.tail(count > 0)), rowCount: () => count, cut: () => false,
  };
}
