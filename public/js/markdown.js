// A small Markdown renderer for the agents' answers. It builds vnodes, never HTML, so a message can only ever show
// text, external links, project-scoped file downloads and highlighted code.
import { html } from './lib.js';
import { CodeBlock } from './code.js';
import { downloadFile } from './api.js';
import { toast } from './store.js';

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+|sandbox:[^\s)]+|<(?:sandbox:|\/)[^>]+>|\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function localDownload(path, conversationId) {
  if (!conversationId) return null;
  if (path.startsWith('<') && path.endsWith('>')) path = path.slice(1, -1);
  if (path.startsWith('sandbox:')) path = path.slice('sandbox:'.length);
  if (!path.startsWith('/')) return null;
  path = path.replace(/:\d+$/, '');
  let filename = path.split('/').pop() || 'download';
  try { filename = decodeURIComponent(filename); } catch { /* keep the literal name */ }
  const query = new URLSearchParams({ path });
  return { href: `/api/conversations/${encodeURIComponent(conversationId)}/files/download?${query}`, filename };
}

function inline(text, conversationId) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(html`<code>${m[1]}</code>`);
    else if (m[2] != null) out.push(html`<strong>${inline(m[2], conversationId)}</strong>`);
    else if (m[3] != null) out.push(html`<em>${inline(m[3])}</em>`);
    else if (m[4] != null) {
      const file = localDownload(m[5], conversationId);
      if (file) out.push(html`<a href=${file.href} download=${file.filename} onClick=${(event) => {
        event.preventDefault();
        void downloadFile(file.href, file.filename).catch((error) => {
          console.error('File download failed:', error);
          toast(`Could not download file: ${error.message}`, 'err');
        });
      }}>${m[4]}</a>`);
      else if (/^https?:\/\//i.test(m[5])) out.push(html`<a href=${m[5]} target="_blank" rel="noopener noreferrer">${m[4]}</a>`);
      else out.push(m[0]);
    }
    else out.push(html`<a href=${m[6]} target="_blank" rel="noopener noreferrer">${m[6]}</a>`);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function Markdown({ text, conversationId }) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const isBlock = (l) => /^(```|#{1,6}\s|>\s?|\s*---+\s*$)/.test(l) || LIST_ITEM.test(l);
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if ((m = /^```\s*([\w+#.-]*)/.exec(l))) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      blocks.push(html`<${CodeBlock} code=${code.join('\n')} lang=${m[1].toLowerCase()} />`);
    } else if ((m = /^(#{1,6})\s+(.*)/.exec(l))) {
      const Tag = `h${Math.min(m[1].length + 2, 6)}`;
      blocks.push(html`<${Tag}>${inline(m[2], conversationId)}</${Tag}>`); i++;
    } else if (/^\s*---+\s*$/.test(l)) {
      blocks.push(html`<hr />`); i++;
    } else if (/^>\s?/.test(l)) {
      const q = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ''));
      blocks.push(html`<blockquote>${inline(q.join(' '), conversationId)}</blockquote>`);
    } else if (l.includes('|') && TABLE_SEP.test(lines[i + 1] || '')) {
      const head = cells(l);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      blocks.push(html`<div class="table-wrap"><table>
        <thead><tr>${head.map((c) => html`<th>${inline(c, conversationId)}</th>`)}</tr></thead>
        <tbody>${rows.map((r) => html`<tr>${head.map((_, j) => html`<td>${inline(r[j] || '', conversationId)}</td>`)}</tr>`)}</tbody>
      </table></div>`);
    } else if (LIST_ITEM.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && (LIST_ITEM.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
        if (LIST_ITEM.test(lines[i])) items.push(lines[i].replace(LIST_ITEM, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`; // a wrapped continuation line
      }
      const lis = items.map((t) => {
        const task = /^\[([ xX])\]\s+/.exec(t);
        return task
          ? html`<li class="task"><input type="checkbox" disabled checked=${task[1] !== ' '} />${inline(t.slice(task[0].length), conversationId)}</li>`
          : html`<li>${inline(t, conversationId)}</li>`;
      });
      blocks.push(ordered ? html`<ol>${lis}</ol>` : html`<ul>${lis}</ul>`);
    } else {
      const p = [];
      for (; i < lines.length && lines[i].trim() && (!p.length || !isBlock(lines[i])) && !(lines[i].includes('|') && TABLE_SEP.test(lines[i + 1] || '')); i++) p.push(lines[i]);
      blocks.push(html`<p>${p.flatMap((x, j) => (j ? [html`<br />`, ...inline(x, conversationId)] : inline(x, conversationId)))}</p>`);
    }
  }
  return html`<div class="md">${blocks}</div>`;
}
