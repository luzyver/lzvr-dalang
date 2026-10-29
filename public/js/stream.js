// A chat's event stream (SSE over fetch, so the token goes in a header) and the thread model that folds the events
// into what the panel shows: prompts, groups of tool steps, answers and notes.
import { api, currentToken, handleUnauthorized } from './api.js';
import { toDate } from './format.js';

/** Split an SSE text buffer into complete events; returns the unfinished remainder. */
function parseSSE(buf) {
  const events = [];
  let rest = buf;
  for (let i = rest.indexOf('\n\n'); i !== -1; i = rest.indexOf('\n\n')) {
    const block = rest.slice(0, i);
    rest = rest.slice(i + 2);
    const ev = { id: 0, type: 'message', data: null, timestamp: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) ev.id = Number(line.slice(3).trim()) || 0;
      else if (line.startsWith('event:')) ev.type = line.slice(6).trim();
      else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5).trim()); } catch { ev.data = null; } }
      else if (line.startsWith('timestamp:')) ev.timestamp = line.slice(10).trim();
    }
    if (ev.data !== null) events.push(ev);
  }
  return { events, rest };
}

/**
 * Follow a conversation's event stream from after event `after`, resuming from the last id after a drop. Long tool
 * output comes cut (see fullStep). Returns a stop function.
 */
export function startStream(convId, onEvents, after = 0) {
  const ac = new AbortController();
  let last = after;
  (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`/api/conversations/${convId}/events?compact=1`, {
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
          if (r.events.length) {
            for (const e of r.events) last = Math.max(last, e.id);
            onEvents(r.events);
          }
        }
      } catch { if (ac.signal.aborted) return; }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return () => ac.abort();
}

const ms = (ts) => toDate(ts)?.getTime() ?? Date.now();
const HOOK_TRUST_NOTICE = '--dangerously-bypass-hook-trust is enabled.';

/**
 * A page of a chat's history in whole turns: `{ events, before, more, last }`. Without `before`, the last turns
 * (reaching back to event `focus`); with it, the turns before turn `before`. `last` is the event to stream on from.
 */
export const historyPage = (convId, { before, focus } = {}) => {
  const q = new URLSearchParams({ turns: '10' });
  if (before) q.set('before', before);
  if (focus) q.set('focus', focus);
  return api(`/api/conversations/${convId}/history?${q}`);
};

/**
 * One tool step from a completed item; a file change gives one step per file. `cut`: the server cut its long output
 * (see fullStep); a cut diff comes with its `stat`.
 */
function steps(item, id, at) {
  const cut = !!item.cut;
  switch (item.type) {
    case 'command_execution':
      return [{ kind: 'command', id, at, cut, command: String(item.command || ''), output: String(item.aggregated_output || ''), exit: item.exit_code }];
    case 'file_change':
      return (item.changes || []).map((c, i) => ({ kind: 'file', id: `${id}.${i}`, at, cut: !!c.stat, stat: c.stat, path: String(c.path || ''), movePath: c.movePath, change: c.kind, diff: c.diff || '' }));
    case 'tool_call': return [{ kind: 'tool', id, at, tool: item.tool || 'tool', text: item.text || '' }];
    case 'reasoning': return item.text ? [{ kind: 'reasoning', id, at, cut, text: String(item.text) }] : [];
    default: return [{ kind: 'tool', id, at, tool: item.type || 'item', text: '' }];
  }
}

/** A cut step in full, from its event (a step's id is its event's, or `event.index` for a file of a file change). */
export async function fullStep(convId, s) {
  const e = await api(`/api/conversations/${convId}/events/${String(s.id).split('.')[0]}`);
  return steps(e.data?.item || {}, Number(String(s.id).split('.')[0]), s.at).find((f) => f.id === s.id) || s;
}

/**
 * The thread of one chat. `apply(events)` folds new events in; `blocks` is what to render (`v` goes up whenever a
 * block changes in place, so its view knows to redraw):
 *   { type: 'user', text, author, at, eventId } · { type: 'agent', text, at, eventId, usage } ·
 *   { type: 'steps', items, start, end, done } · { type: 'note', text, tone }
 * plus `live` (what the agent is doing right now), `startedAt` (the running turn's start) and `account`.
 */
export class ThreadModel {
  blocks = [];
  live = null;
  startedAt = null;
  account = '';
  #steps = null; // the group new steps go into
  #turnAgent = null; // the turn's last answer, which gets the token usage
  #mark = null; // when the agent last started working on something: a step group's start

  #note(text, tone, id) { this.blocks.push({ type: 'note', key: `n${id}`, text, tone, v: 0 }); }

  apply(events) {
    for (const e of events) this.#one(e);
    this.blocks = [...this.blocks]; // a new array, so a memoised list sees the change
  }

  #one(e) {
    const d = e.data || {};
    const at = ms(e.timestamp);
    switch (e.type) {
      case 'turn.selection': {
        if (!d.previous || !d.current) break;
        const label = (backend) => backend === 'claude' ? 'Claude Code' : 'Codex';
        const model = (selection) => selection.model || `${label(selection.backend)} default`;
        const changes = [];
        if (d.previous.backend !== d.current.backend) changes.push(`Agent changed: ${label(d.previous.backend)} → ${label(d.current.backend)}`);
        if (d.previous.model !== d.current.model) changes.push(`Model changed: ${model(d.previous)} → ${model(d.current)}`);
        if (changes.length) {
          this.#closeSteps();
          this.#note(changes.join(' · '), 'dim', e.id);
        }
        break;
      }
      case 'user.prompt':
        this.#closeSteps();
        this.#turnAgent = null;
        this.blocks.push({ type: 'user', key: `u${e.id}`, text: d.text || '', author: d.author || '', resumed: !!d.resumed, files: d.attachments || [], at, eventId: e.id, v: 0 });
        this.#mark = at;
        break;
      case 'turn.started': this.startedAt = at; this.#mark = at; break;
      case 'item.started':
        if (d.item?.type === 'command_execution') this.live = { label: 'Running', detail: String(d.item.command || '') };
        else if (d.item?.type === 'file_change') this.live = { label: 'Editing files', detail: '' };
        else if (d.item?.type === 'reasoning') this.live = { label: 'Thinking', detail: '' };
        break;
      case 'item.completed': {
        const item = d.item;
        if (!item) break;
        this.live = null;
        if (item.type === 'error') {
          this.#closeSteps();
          const message = typeof item.message === 'string' ? item.message : 'The agent reported an error.';
          this.#note(message, message.includes(HOOK_TRUST_NOTICE) ? 'warn' : 'err', e.id);
          break;
        }
        if (item.type === 'agent_message') {
          this.#closeSteps();
          const block = { type: 'agent', key: `a${e.id}`, text: item.text || '', at, eventId: e.id, usage: null, v: 0 };
          this.blocks.push(block);
          this.#turnAgent = block;
          this.#mark = at;
          break;
        }
        const add = steps(item, e.id, at);
        if (!add.length) break;
        if (!this.#steps) {
          this.#steps = { type: 'steps', key: `s${e.id}`, items: [], start: this.#mark ?? at, end: at, done: false, v: 0 };
          this.blocks.push(this.#steps);
        }
        this.#steps.items.push(...add);
        this.#steps.end = at;
        this.#steps.v++;
        break;
      }
      case 'turn.completed':
        if (this.#turnAgent) { this.#turnAgent.usage = 'turn_usage' in d ? d.turn_usage : d.usage || null; this.#turnAgent.v++; }
        else this.#note('Turn finished without an answer', 'dim', e.id);
        this.#endTurn();
        break;
      case 'turn.failed':
      case 'error':
        this.#note(`Error: ${(d.error && d.error.message) || d.message || JSON.stringify(d)}`, 'err', e.id);
        this.#endTurn();
        break;
      case 'process.exit':
        this.#note(`The agent process exited (${d.code})${d.stderr ? `: ${String(d.stderr).slice(-300)}` : ''}`, 'err', e.id);
        this.#endTurn();
        break;
      case 'turn.status': this.#endTurn(); break;
      case 'account.selected': this.account = d.account || ''; break;
      case 'account.switched': this.#note(`Usage limit on ${d.from}: switching account`, 'warn', e.id); break;
      case 'account.exhausted': this.#note(d.message || 'Every account is at its usage limit', 'err', e.id); break;
      case 'context.compacting': this.#closeSteps(); this.live = { label: 'Compacting context', detail: '' }; break;
      case 'context.compacted': this.live = null; this.#closeSteps(); this.#note('Context compacted; continuing in the same session. Full history remains available.', 'dim', e.id); break;
      case 'context.usage': break;
      case 'code_memory.indexing': this.#note('The code changed since its graph was indexed: reindexing before the agent starts', 'dim', e.id); break;
      case 'code_memory.indexed': this.#note('Code graph reindexed', 'dim', e.id); break;
      case 'code_memory.failed': this.#note('Could not reindex the code graph (see Settings → MCP → Code memory): the agent reads the previous one', 'warn', e.id); break;
      case 'review.started': this.#note(`Reviewer checking ${d.files} changed file${d.files === 1 ? '' : 's'} (round ${d.round})`, 'dim', e.id); break;
      case 'review.passed': this.#note(`Reviewer: no problems found${d.earlier ? ' in a change from before the latest request' : ''} (round ${d.round})`, 'dim', e.id); break;
      case 'review.issues': this.#note(d.earlier
        ? `Reviewer found problems in a change from before the latest request (round ${d.round}): sent to this chat to check`
        : `Reviewer found problems (round ${d.round}): sent to this chat to fix`, 'warn', e.id); break;
      case 'review.failed': this.#note(`Reviewer did not finish${d.earlier ? ' an earlier review' : ''} (round ${d.round}, ${d.status})`, 'warn', e.id); break;
      case 'thread.started':
      case 'item.updated':
      case 'conversation.title':
        break;
      default: this.#note(e.type, 'dim', e.id);
    }
  }

  #closeSteps() {
    if (this.#steps) { this.#steps.done = true; this.#steps.v++; }
    this.#steps = null;
  }

  #endTurn() {
    this.#closeSteps();
    this.live = null;
    this.startedAt = null;
  }
}
