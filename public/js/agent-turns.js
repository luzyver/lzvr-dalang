// The turns of the chat a person started, under its agent tree: how many there are and in which ones its agent put
// sub-agents to work or the automatic review ran. Every prompt one chat sends another records the sender's turn, so an
// agent given work again in a later turn (a reused reviewer, a second send_prompt) counts for each of those turns; a
// deeper agent counts for the turn of the main chat its branch worked for (the server's agent_turns).
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { Icon } from './ui.js';
import { openChat } from './store.js';
import { ago } from './inbox.js';

/** The turns of `rootId` (oldest first) and which agents each put to work, fetched again when the chats move on; null while loading. */
function useTurns(rootId, key) {
  const [turns, setTurns] = useState(null);
  useEffect(() => {
    let live = true;
    api(`/api/conversations/${rootId}`).then((c) => { if (live) setTurns({ turns: c.turns || [], links: c.agent_turns || [] }); },
      () => { if (live) setTurns({ turns: [], links: [] }); });
    return () => { live = false; };
  }, [rootId, key]);
  return turns;
}

/**
 * For each turn id of the root, the agents of the tree it put to work (`links`: the server's {turn, conv} rows); agents
 * no turn is known for (no prompt from the tree recorded) go under `null`.
 */
export function agentsByTurn(links, agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out = new Map();
  const linked = new Set();
  for (const { turn, conv } of links) {
    const a = byId.get(conv);
    const list = out.get(turn) || [];
    if (!a || list.includes(a)) continue;
    out.set(turn, [...list, a]);
    linked.add(conv);
  }
  const rest = agents.filter((a) => !linked.has(a.id));
  if (rest.length) out.set(null, rest);
  return out;
}

const snippet = (prompt) => {
  const line = (prompt || '').trim().split('\n')[0];
  return line.length > 90 ? `${line.slice(0, 90)}…` : line || '(no prompt)';
};

function TurnRow({ n, turn, agents }) {
  const [open, setOpen] = useState(false);
  const has = agents.length > 0;
  const label = n ? `Turn ${n}` : 'Turn not recorded';
  const head = html`
    <span class="turn-no">${label}</span>
    <span class="turn-prompt" title=${turn?.prompt || ''}>${turn ? snippet(turn.prompt) : 'No turn of this chat recorded for these'}</span>
    ${has && html`<span class="turn-agents"><${Icon} name="bot" class="tiny" />${agents.length}</span>`}
    ${turn && html`<span class=${cx('turn-when', turn.status)}>${turn.status === 'running' ? 'now' : ago(turn.ended_at || turn.started_at)}</span>`}`;
  return html`<li class=${cx('turn-row', has && 'orch')}>
    ${has
      ? html`<button class="turn-head" aria-expanded=${open} onClick=${() => setOpen(!open)}>
          <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" />${head}</button>`
      : html`<div class="turn-head"><span class="turn-spacer"></span>${head}</div>`}
    ${open && html`<ul class="turn-kids">${agents.map((a) => html`<li key=${a.id}>
      <a href=${`#c=${a.id}`} onClick=${(e) => { e.preventDefault(); openChat(a.id); }}>
        <span class=${cx('dot', a.status)}></span>${a.title || (a.role === 'reviewer' ? 'Review' : 'New chat')}
        ${a.role === 'reviewer' && html`<span class="turn-kind">Reviewer</span>`}</a></li>`)}</ul>`}
  </li>`;
}

/** "Turns": the root chat's turn count, the ones that started agents, and on demand every turn, newest first. */
export function TurnsSection({ root, agents }) {
  const [all, setAll] = useState(false);
  const data = useTurns(root.id, [root, ...agents].map((c) => `${c.id}:${c.status}:${c.last_at}`).join('|'));
  if (!data) return null;
  const { turns } = data;
  const started = agentsByTurn(data.links, agents);
  const rows = turns.map((t, i) => ({ n: i + 1, turn: t, agents: started.get(t.id) || [] }));
  const known = new Set(turns.map((t) => t.id));
  const lost = [...started].filter(([k]) => !known.has(k)).flatMap(([, v]) => v);
  const orch = rows.filter((r) => r.agents.length);
  const shown = (all ? rows : orch).slice().reverse();
  return html`<section class="turns" aria-label="Turns of this chat">
    <div class="turns-head">
      <span class="turns-title">Turns</span>
      <span class="turns-count">${turns.length} turn${turns.length === 1 ? '' : 's'} · ${orch.length} with agents</span>
      ${turns.length > orch.length && html`<button class="turns-toggle" onClick=${() => setAll(!all)}>
        ${all ? 'Only with agents' : 'Show all'}</button>`}
    </div>
    ${shown.length || lost.length
      ? html`<ul class="turn-list">
          ${shown.map((r) => html`<${TurnRow} key=${r.turn.id} ...${r} />`)}
          ${lost.length > 0 && html`<${TurnRow} n=${0} turn=${null} agents=${lost} />`}
        </ul>`
      : html`<p class="agents-note">${turns.length ? 'No turn has started agents yet.' : 'No turns yet.'}</p>`}
  </section>`;
}
