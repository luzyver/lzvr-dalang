// An open chat: the header (context, run state, branch), the thread and the composer. Its state lives in `chat`, which
// the inspector (Changes, Schedules, Info) reads too.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { batch, signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { confirmDialog, Icon } from './ui.js';
import {
  approvals, dbApprovals, sshApprovals, findConv, guarded, isAdmin, openCodeEditor, patchConv, refreshApprovals, route, toast, toggleInspector, toggleSidebar, ui,
} from './store.js';
import { historyPage, startStream, ThreadModel } from './stream.js';
import { Block, Elapsed, Live } from './thread.js';
import { Composer } from './composer.js';
import { ApprovalCard, DbApprovalCard, SshApprovalCard } from './approvals.js';
import { MemoryButton } from './memory.js';

/** The open chat, shared with the inspector. `version` goes up whenever the thread model changed. */
export const chat = {
  id: signal(null),
  conv: signal(null),
  git: signal(null),
  queue: signal([]),
  version: signal(0),
  model: new ThreadModel(),
  /** The turns not loaded yet: `{ before, more, loading }`; null until the first page came. */
  older: signal(null),
  /** The events the model was built from, so earlier turns can be folded in ahead of them. */
  events: [],
  /** Goes up each time a chat is opened (also the same one again): an answer for an earlier opening is dropped. */
  session: 0,
  /** A search hit to load back to once the page being loaded is in (it may not reach that far). */
  focus: null,
  /** The first event loaded (set as a page comes, before its events are folded in). */
  first: null,
};

/**
 * Fold the page of turns before the loaded ones in ahead of them (back to event `focus` when given): the model is built
 * again from all of them. `beforeSwap` runs just before the thread changes (to keep the scroll position).
 */
async function loadEarlier(id, focus, beforeSwap) {
  const o = chat.older.peek();
  if (!o?.more) return;
  if (o.loading) { if (focus) chat.focus = focus; return; }
  const session = chat.session;
  chat.older.value = { ...o, loading: true };
  try {
    const page = await historyPage(id, { before: o.before, focus });
    if (chat.session !== session) return;
    chat.events = [...page.events, ...chat.events];
    chat.first = page.events[0]?.id ?? chat.first;
    const model = new ThreadModel();
    model.apply(chat.events);
    beforeSwap?.();
    batch(() => {
      chat.model = model;
      chat.older.value = { before: page.before, more: page.more };
      chat.version.value++;
    });
  } catch (e) {
    if (chat.session !== session) return;
    chat.older.value = o;
    toast(e.message, 'err');
  }
  if (chat.session === session) await focusWanted(id, beforeSwap);
}

/** A search hit asked for while a page loaded, and not in what is loaded now: load back to it. */
async function focusWanted(id, beforeSwap) {
  const wanted = chat.focus;
  chat.focus = null;
  if (wanted && chat.first && Number(wanted) < chat.first) await loadEarlier(id, wanted, beforeSwap);
}

export async function refreshConv(id = chat.id.value) {
  const c = await api(`/api/conversations/${id}`);
  if (chat.id.value !== id) return;
  chat.conv.value = c;
  patchConv(id, { status: c.status, ...(c.title && { title: c.title }) });
}
export async function refreshQueue(id = chat.id.value) {
  const q = await api(`/api/conversations/${id}/queue`);
  if (chat.id.value === id) chat.queue.value = q;
}
export async function refreshGit(id = chat.id.value) {
  const s = await api(`/api/conversations/${id}/git`);
  if (chat.id.value === id) chat.git.value = s;
}

const TURN_END = new Set(['turn.completed', 'turn.failed', 'turn.status', 'process.exit', 'user.prompt']);

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/**
 * The project's code graph (code memory): when it was indexed, and indexing it again. An admin starts it at once; anyone
 * else asks, and it runs once an admin approves. Hidden while code memory is off.
 */
function CodeGraphButton({ project }) {
  const [s, setS] = useState(null);
  const git = chat.git.value; // refreshed after each turn and git action: the code may have changed
  const shown = useRef(null); // the project whose state `s` is, so an answer for the one before is dropped
  // A failed look (the network, a restart) keeps what was known: the next one corrects it.
  const load = () => {
    if (!project) return;
    const id = project.id;
    api(`/api/projects/${id}/code-memory`).then((r) => { if (shown.current === id) setS(r); }, () => {});
  };
  useEffect(() => { shown.current = project?.id ?? null; setS(null); load(); }, [project?.id]);
  useEffect(() => { if (git) load(); }, [git]);
  const indexing = s?.index?.status === 'indexing';
  // Look again while an index runs (often), and while a request waits for an admin (now and then): nothing else says
  // when an admin decided.
  const every = indexing ? 3000 : s?.pending ? 15000 : 0;
  useEffect(() => {
    if (!every) return undefined;
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [every, project?.id]);
  const st = s?.index;
  // Only when there is something to index: code changed since the graph was built, or no graph yet; and while it is
  // being indexed or asked for, so the click shows.
  if (!s?.enabled || !(s.changed || !st?.graph || indexing || s.pending)) return null;
  const state = !st?.graph ? (st?.status === 'failed' ? `Failed: ${st.error}` : 'Not indexed yet')
    : indexing ? 'Indexing…' : `Indexed ${ago(st.indexedAt)}${s.changed ? ', files changed since' : ''}`;
  const action = s.pending ? `Waiting for an admin to approve ${s.pending.who}'s request` : `Click to ${st?.graph ? 'index it again' : 'index it'}${s.direct ? '' : ' (an admin approves)'}`;
  const click = guarded(async () => {
    if (s.pending || indexing) return toast(s.pending ? 'Already asked: waiting for an admin in Approvals' : 'Already indexing');
    const ok = await confirmDialog({
      title: `${st?.graph ? 'Reindex' : 'Index'} the code graph of ${project.name}?`,
      message: s.direct
        ? 'It starts now and uses several cores for a while (seconds to minutes; again, it only reads what changed). Chats get the new graph from their next turn.'
        : 'An admin or the owner approves it first in Approvals; it runs then. Chats get the new graph from their next turn.',
      confirmText: s.direct ? 'Index now' : 'Ask for approval',
    });
    if (!ok) return;
    const r = await api(`/api/projects/${project.id}/code-memory/index`, { method: 'POST' });
    toast(r.status === 'indexing' ? 'Indexing started' : 'Asked: an admin approves it in Approvals');
    await load();
    if (isAdmin.value) refreshApprovals();
  });
  return html`<button class=${cx('icon-btn', (s.changed || !st?.graph) && 'on')} aria-label="Code graph" title=${`Code graph: ${state}. ${action}`} onClick=${click}>
    <${Icon} name=${indexing ? 'loader-circle' : 'brain'} spin=${indexing} /></button>`;
}

function ChatHead({ project, conv }) {
  chat.version.value; // the running turn's start and account come from the thread model
  const c = chat.conv.value || conv;
  const git = chat.git.value;
  const status = c?.status || 'idle';
  const claude = (c?.backend || project?.backend) === 'claude';
  const backend = claude ? 'Claude Code' : 'Codex';
  return html`<header class="chat-head">
    <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" title="Sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
    <div class="crumbs">
      <span class="crumb-project">${project?.name}</span>
      <${Icon} name="chevron-right" class="tiny dim crumb-sep" />
      <span class="crumb-title" title=${c?.title || 'New chat'}>${c?.title || 'New chat'}</span>
    </div>
    <span class="backend" title=${`Agent: ${backend}`} aria-label=${backend} role="img"><${Icon} name=${claude ? 'asterisk' : 'code-xml'} /></span>
    ${status === 'running' && html`<span class="status running" title=${chat.model.account ? `on account ${chat.model.account}` : ''}>
      <${Icon} name="loader-circle" spin />Running${chat.model.startedAt && html` · <${Elapsed} since=${chat.model.startedAt} />`}</span>`}
    ${status === 'failed' && html`<span class="status failed"><${Icon} name="circle-alert" />Failed</span>`}
    <div class="spacer"></div>
    <${CodeGraphButton} project=${project} />
    <${MemoryButton} project=${project} />
    <button class="icon-btn" aria-label="Open code editor" title="Open code editor (new tab): files, editor and terminal" onClick=${() => openCodeEditor(chat.id.value)}><${Icon} name="square-code" /></button>
    <button class="icon-btn" aria-label="Scheduled prompts" title="Scheduled prompts" onClick=${() => toggleInspector(true, 'schedules')}><${Icon} name="clock" /></button>
    ${git?.repo && html`<button class="branch-btn" title="Changes: review, commit, revert" onClick=${() => toggleInspector(true, 'changes')}>
      <${Icon} name="git-branch" /><span class="branch-name">${git.branch || 'HEAD'}</span>
      ${git.files.length > 0 && html`<span class="branch-count">${git.files.length}</span>`}
    </button>`}
    <button class=${cx('icon-btn', ui.inspectorOpen.value && 'on')} aria-label="Inspector" title="Inspector" aria-pressed=${ui.inspectorOpen.value} onClick=${() => toggleInspector()}><${Icon} name="panel-right" /></button>
  </header>`;
}

export function ChatView({ id, focusEvent }) {
  const found = findConv(id);
  const scroller = useRef(null);
  const stick = useRef(true); // follow new output while the user is at the bottom
  const pinned = useRef(0); // a search hit was just scrolled to: the replay after it must not scroll it away
  const keep = useRef(null); // earlier turns go in above: where the view was, so it stays put
  const [hitShown, setHitShown] = useState(false);
  const keepScroll = () => {
    const el = scroller.current;
    if (el) keep.current = { height: el.scrollHeight, top: el.scrollTop };
  };

  // Reset during render, not in an effect, so the first frame of a newly opened chat never shows the previous one.
  if (chat.id.peek() !== id) {
    batch(() => {
      chat.id.value = id;
      chat.conv.value = found?.conv || null;
      chat.git.value = null;
      chat.queue.value = [];
      chat.model = new ThreadModel();
      chat.older.value = null;
      chat.events = [];
      chat.session++;
      chat.focus = null;
      chat.first = null;
      chat.version.value++;
    });
  }

  useEffect(() => {
    stick.current = true;
    setHitShown(false);
    let frame = 0;
    let pending = [];
    let stop = () => {};
    let gone = false;
    // Many events arrive at once while the history replays: fold them in once per frame.
    const flush = () => {
      frame = 0;
      const events = pending;
      pending = [];
      chat.events.push(...events);
      chat.model.apply(events);
      chat.version.value++;
      if (events.some((e) => TURN_END.has(e.type))) {
        refreshQueue(id).catch(() => {});
        refreshConv(id).catch(() => {});
      }
      if (events.some((e) => e.type === 'turn.status')) refreshGit(id).catch(() => {});
      if (events.some((e) => e.type === 'conversation.title')) refreshConv(id).catch(() => {});
    };
    const take = (events) => {
      pending.push(...events);
      frame ||= requestAnimationFrame(flush);
    };
    // The last turns first (a long chat is megabytes), then the stream on from them; earlier turns on request.
    historyPage(id, { focus: focusEvent }).then((page) => {
      if (gone) return;
      chat.older.value = { before: page.before, more: page.more };
      chat.first = page.events[0]?.id ?? null;
      if (page.events.length) take(page.events);
      focusWanted(id, keepScroll); // a search hit in this chat that came while this page loaded
      stop = startStream(id, take, page.last);
    }, () => {
      if (gone) return;
      chat.older.value = { before: null, more: false };
      stop = startStream(id, take); // the whole history over the stream
    });
    refreshConv(id).catch(() => {});
    refreshQueue(id).catch(() => {});
    refreshGit(id).catch(() => {});
    return () => {
      gone = true;
      stop();
      cancelAnimationFrame(frame);
      if (chat.id.peek() === id) chat.id.value = null; // reopening it later replays the stream into a fresh model
    };
  }, [id]);

  const earlier = (focus) => loadEarlier(id, focus, keepScroll);
  // A search hit in this chat, before the turns loaded: load back to it.
  useEffect(() => {
    if (!focusEvent) return;
    setHitShown(false);
    const o = chat.older.peek();
    if (!o || o.loading) { chat.focus = focusEvent; return; } // a page is on its way: on from it once it is in
    if (chat.first && Number(focusEvent) < chat.first) earlier(focusEvent);
  }, [focusEvent]);

  const version = chat.version.value;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const kept = keep.current;
    keep.current = null;
    if (focusEvent && !hitShown) {
      const hit = el.querySelector(`[data-event="${focusEvent}"]`);
      if (hit) {
        hit.scrollIntoView({ block: 'center' });
        pinned.current = Date.now() + 2000;
        stick.current = false;
        setHitShown(true);
        return;
      }
    }
    if (kept) { el.scrollTop = kept.top + el.scrollHeight - kept.height; return; }
    if (stick.current && Date.now() > pinned.current) el.scrollTop = el.scrollHeight;
  }, [version]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 200 && !stick.current) earlier(); // reading up to the top: the turns before come on their own
  };

  const model = chat.model;
  const conv = chat.conv.value || found?.conv;
  const running = conv?.status === 'running';
  const lastSteps = model.blocks.length && model.blocks[model.blocks.length - 1].type === 'steps' ? model.blocks[model.blocks.length - 1] : null;
  const waiting = approvals.value.filter((a) => a.to_conv === id);
  const writes = dbApprovals.value.filter((a) => a.conv === id);
  const commands = sshApprovals.value.filter((a) => a.conv === id);
  const focus = route.value.focusEvent;
  const older = chat.older.value;

  return html`<main class="main">
    <${ChatHead} project=${found?.project} conv=${found?.conv} />
    <div class="thread" ref=${scroller} onScroll=${onScroll}>
      <div class="thread-inner">
        ${older?.more && html`<button class="btn sm thread-earlier" disabled=${older.loading} onClick=${() => earlier()}>
          ${older.loading ? html`<${Icon} name="loader-circle" spin />Loading earlier turns…` : html`<${Icon} name="arrow-up" />Load earlier turns`}</button>`}
        ${older && !model.blocks.length && !running && html`<div class="thread-empty">
          <div class="empty-icon"><${Icon} name="message-square" /></div>
          <strong>Start the conversation</strong>
          <span class="dim">${found?.project?.name}: the agent works in ${conv?.worktree ? `its own worktree on ${conv.branch}` : 'the project folder'}.</span>
        </div>`}
        ${model.blocks.map((b) => html`<${Block} key=${b.key} b=${b} v=${b.v} hit=${focus != null && b.eventId === focus} active=${running && b === lastSteps && !b.done} root=${conv?.worktree || found?.project?.path} conversationId=${conv?.id} />`)}
        ${waiting.map((a) => html`<${ApprovalCard} key=${a.id} a=${a} />`)}
        ${writes.map((a) => html`<${DbApprovalCard} key=${`db${a.id}`} a=${a} />`)}
        ${commands.map((a) => html`<${SshApprovalCard} key=${`ssh${a.id}`} a=${a} />`)}
        ${running && html`<${Live} live=${model.live} since=${model.startedAt} />`}
      </div>
    </div>
    <${Composer} id=${id} project=${found?.project} />
  </main>`;
}
