import { h } from './dom.js';
import { currentToken, handleUnauthorized } from './api.js';

/** Split an SSE text buffer into complete events; returns the unfinished remainder. */
function parseSSE(buf) {
  const events = [];
  let rest = buf;
  for (let i = rest.indexOf('\n\n'); i !== -1; i = rest.indexOf('\n\n')) {
    const block = rest.slice(0, i);
    rest = rest.slice(i + 2);
    const ev = { id: 0, type: 'message', data: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) ev.id = Number(line.slice(3).trim()) || 0;
      else if (line.startsWith('event:')) ev.type = line.slice(6).trim();
      else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5).trim()); } catch { ev.data = null; } }
    }
    if (ev.data !== null) events.push(ev);
  }
  return { events, rest };
}

/** Follow a conversation's event stream, resuming from the last id after a drop. Returns a stop function. */
export function startStream(convId, onEvent) {
  const ac = new AbortController();
  let last = 0;
  (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`/api/conversations/${convId}/events`, {
          headers: { authorization: `Bearer ${currentToken()}`, 'last-event-id': String(last) },
          signal: ac.signal,
        });
        if (res.status === 401) { handleUnauthorized(); return; }
        if (!res.ok) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const r = parseSSE(buf);
          buf = r.rest;
          for (const e of r.events) { last = Math.max(last, e.id); onEvent(e); }
        }
      } catch { if (ac.signal.aborted) return; }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return () => ac.abort();
}

// ---------- markdown (DOM-built, never innerHTML: the CSP and the textContent rule both hold) ----------
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(h('code', {}, m[1]));
    else if (m[2] != null) out.push(h('strong', {}, inline(m[2])));
    else if (m[3] != null) out.push(h('em', {}, inline(m[3])));
    else out.push(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer' }, m[4]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s/;
function markdown(src) {
  const root = h('div', { class: 'md' });
  const lines = String(src).replace(/\r/g, '').split('\n');
  const isBlock = (l) => /^(```|#{1,6}\s|>\s?)/.test(l) || LIST_ITEM.test(l);
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
    } else if ((m = /^(#{1,6})\s+(.*)/.exec(l))) {
      root.append(h(`h${Math.min(m[1].length + 2, 6)}`, {}, inline(m[2]))); i++;
    } else if (/^>\s?/.test(l)) {
      const q = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ''));
      root.append(h('blockquote', {}, inline(q.join(' '))));
    } else if (LIST_ITEM.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) items.push(h('li', {}, inline(lines[i].replace(LIST_ITEM, ''))));
      root.append(h(ordered ? 'ol' : 'ul', {}, items));
    } else {
      const p = [];
      for (; i < lines.length && lines[i].trim() && (!p.length || !isBlock(lines[i])); i++) p.push(lines[i]);
      root.append(h('p', {}, p.flatMap((x, j) => (j ? [h('br'), ...inline(x)] : inline(x)))));
    }
  }
  return root;
}

// ---------- event rendering ----------
const note = (text, cls) => h('div', { class: `note ${cls || ''}` }, text);
const bubble = (cls, text) => h('div', { class: `msg ${cls}` }, text);

function renderItem(item) {
  if (!item) return null;
  switch (item.type) {
    case 'agent_message': return h('div', { class: 'msg agent' }, markdown(item.text || ''));
    case 'command_execution': {
      const out = h('span', { class: 'out' }, String(item.aggregated_output || '').slice(-2000));
      const code = item.exit_code == null ? '' : `  [exit ${item.exit_code}]`;
      return h('div', { class: 'msg cmd' }, `$ ${item.command || ''}${code}`, out);
    }
    case 'file_change': {
      const files = (item.changes || []).map((c) => `${c.kind || 'change'} ${c.path || ''}`).join('\n');
      return bubble('cmd', files || 'file change');
    }
    case 'reasoning': return item.text ? note(`thinking: ${String(item.text).slice(0, 300)}`) : null;
    default: return note(`${item.type || 'item'}`);
  }
}

export function renderEvent(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'user.prompt': return bubble('user', d.text || '');
    case 'item.completed': return renderItem(d.item);
    case 'turn.completed': {
      const u = d.usage || {};
      return note(`done · tokens in ${u.input_tokens ?? '?'} / out ${u.output_tokens ?? '?'}`);
    }
    case 'turn.failed':
    case 'error': return note(`error: ${(d.error && d.error.message) || d.message || JSON.stringify(d)}`, 'err');
    case 'process.exit': return note(`process exited (${d.code})${d.stderr ? `: ${String(d.stderr).slice(-300)}` : ''}`, 'err');
    case 'account.selected': return note(`account: ${d.account}`);
    case 'account.switched': return note(`usage limit on ${d.from}, switching account`, 'warn');
    case 'account.exhausted': return note(d.message || 'all accounts are at their limit', 'err');
    case 'thread.started':
    case 'turn.started':
    case 'item.started':
    case 'item.updated': return null;
    default: return note(e.type);
  }
}
