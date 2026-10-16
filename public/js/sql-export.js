// The SQL editor's result formats, to download or copy: CSV, TSV, JSON, JSON Lines, Excel (a real .xlsx, written here
// with a small store-only zip), SQL INSERT statements, Markdown and HTML. Only the rows the result holds (up to the row
// limit) are written.

const csvCell = (v) => (v === null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const tsvCell = (v) => (v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '));
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A value as an SQL literal for `driver` (MySQL and MariaDB read backslashes in strings as escapes). */
function literal(v, driver) {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${v}'`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = String(v).replace(/'/g, '\'\'');
  return `'${driver === 'mysql' || driver === 'mariadb' ? s.replace(/\\/g, '\\\\') : s}'`;
}
const ident = (name, driver) => (driver === 'mysql' || driver === 'mariadb' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`);

function insertStatements(r, { driver, table }) {
  const target = table ? (table.schema && driver !== 'sqlite' ? `${ident(table.schema, driver)}.${ident(table.table, driver)}` : ident(table.table, driver)) : ident('result', driver);
  const cols = r.columns.map((c) => ident(c.name, driver)).join(', ');
  return r.rows.map((row) => `INSERT INTO ${target} (${cols}) VALUES (${row.map((v) => literal(v, driver)).join(', ')});`).join('\n');
}

function markdown(r) {
  const cell = (v) => (v === null ? 'NULL' : String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'));
  return [`| ${r.columns.map((c) => cell(c.name)).join(' | ')} |`, `| ${r.columns.map(() => '---').join(' | ')} |`,
    ...r.rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

function htmlTable(r) {
  const head = r.columns.map((c) => `<th>${esc(c.name)}</th>`).join('');
  const body = r.rows.map((row) => `<tr>${row.map((v) => (v === null ? '<td><i>NULL</i></td>' : `<td>${esc(v)}</td>`)).join('')}</tr>`).join('\n');
  return `<!doctype html>\n<meta charset="utf-8">\n<table border="1" cellspacing="0" cellpadding="4">\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>\n`;
}

// ---------- .xlsx ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `files` ({ name, text }), stored without compression (as a .xlsx may be). */
function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(10, 0, true); local.setUint16(12, 0x21, true); // 1980-01-01, no time
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true); head.setUint16(4, 20, true); head.setUint16(6, 20, true); head.setUint16(8, 0x0800, true);
    head.setUint16(14, 0x21, true); head.setUint32(16, crc, true); head.setUint32(20, data.length, true); head.setUint32(24, data.length, true);
    head.setUint16(28, name.length, true); head.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// Characters XML 1.0 cannot hold go; Excel also stops a cell at 32 767 characters.
const xmlText = (v) => esc(String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').slice(0, 32767));

function xlsx(r, { sheet }) {
  const cell = (v, ref, style) => {
    if (v === null) return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"${style}><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`;
  };
  const rows = [r.columns.map((c) => c.name), ...r.rows].map((row, y) => `<row r="${y + 1}">${row.map((v, x) => cell(v, `${colName(x)}${y + 1}`, y === 0 ? ' s="1"' : '')).join('')}</row>`);
  const name = xmlText((sheet || 'Result').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Result');
  return zip([
    { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rows.join('')}</sheetData></worksheet>` },
  ]);
}

/**
 * The formats: `build(result, { driver, table, sheet })` gives text, or a Blob (Excel). `copy`: it makes sense on the
 * clipboard too; `bom`: the downloaded file starts with a UTF-8 byte order mark.
 */
export const FORMATS = [
  // A downloaded CSV starts with a byte order mark: Excel reads it as UTF-8 then (else accents and CJK come out garbled).
  { id: 'csv', label: 'CSV', ext: 'csv', type: 'text/csv', copy: true, bom: true,
    build: (r) => [r.columns.map((c) => csvCell(c.name)).join(','), ...r.rows.map((row) => row.map(csvCell).join(','))].join('\r\n') },
  { id: 'tsv', label: 'TSV (pastes into a spreadsheet)', ext: 'tsv', type: 'text/tab-separated-values', copy: true,
    build: (r) => [r.columns.map((c) => tsvCell(c.name)).join('\t'), ...r.rows.map((row) => row.map(tsvCell).join('\t'))].join('\n') },
  { id: 'xlsx', label: 'Excel', ext: 'xlsx', build: xlsx },
  { id: 'json', label: 'JSON', ext: 'json', type: 'application/json', copy: true, build: (r) => JSON.stringify(objects(r), null, 2) },
  { id: 'jsonl', label: 'JSON Lines', ext: 'jsonl', type: 'application/x-ndjson', copy: true, build: (r) => objects(r).map((o) => JSON.stringify(o)).join('\n') },
  { id: 'sql', label: 'SQL INSERT statements', ext: 'sql', type: 'application/sql', copy: true, build: insertStatements },
  { id: 'md', label: 'Markdown table', ext: 'md', type: 'text/markdown', copy: true, build: markdown },
  { id: 'html', label: 'HTML table', ext: 'html', type: 'text/html', copy: true, build: htmlTable },
];

/** A file name without the characters Windows, macOS or Linux refuse (and without the extension, added on download). */
export const safeFileName = (name) => name.replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 150);

/** Downloads `result` as `format`, named `name.<ext>`. */
export function download(format, result, ctx, name) {
  const out = format.build(result, ctx);
  const blob = out instanceof Blob ? out : new Blob([format.bom ? '\uFEFF' : '', out], { type: `${format.type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `${safeFileName(name) || 'result'}.${format.ext}`, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
