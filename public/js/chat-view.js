// An open chat: the header (context, run state, branch), the thread and the composer. Its state lives in `chat`, which
// the inspector (Changes, Schedules, Info) reads too.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { batch, signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { Icon } from './ui.js';
import { approvals, findConv, openCodeEditor, patchConv, route, toggleInspector, toggleSidebar, ui } from './store.js';
import { startStream, ThreadModel } from './stream.js';
import { Block, Elapsed, Live } from './thread.js';
import { Composer } from './composer.js';
import { ApprovalCard } from './approvals.js';

/** The open chat, shared with the inspector. `version` goes up whenever the thread model changed. */
export const chat = {
  id: signal(null),
  conv: signal(null),
  git: signal(null),
  queue: signal([]),
  version: signal(0),
  model: new ThreadModel(),
};

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
  const [hitShown, setHitShown] = useState(false);

  // Reset during render, not in an effect, so the first frame of a newly opened chat never shows the previous one.
  if (chat.id.peek() !== id) {
    batch(() => {
      chat.id.value = id;
      chat.conv.value = found?.conv || null;
      chat.git.value = null;
      chat.queue.value = [];
      chat.model = new ThreadModel();
      chat.version.value++;
    });
  }

  useEffect(() => {
    stick.current = true;
    setHitShown(false);
    let frame = 0;
    let pending = [];
    // Many events arrive at once while the history replays: fold them in once per frame.
    const flush = () => {
      frame = 0;
      const events = pending;
      pending = [];
      chat.model.apply(events);
      chat.version.value++;
      if (events.some((e) => TURN_END.has(e.type))) {
        refreshQueue(id).catch(() => {});
        refreshConv(id).catch(() => {});
      }
      if (events.some((e) => e.type === 'turn.status')) refreshGit(id).catch(() => {});
      if (events.some((e) => e.type === 'conversation.title')) refreshConv(id).catch(() => {});
    };
    const stop = startStream(id, (events) => {
      pending.push(...events);
      frame ||= requestAnimationFrame(flush);
    });
    refreshConv(id).catch(() => {});
    refreshQueue(id).catch(() => {});
    refreshGit(id).catch(() => {});
    return () => {
      stop();
      cancelAnimationFrame(frame);
      if (chat.id.peek() === id) chat.id.value = null; // reopening it later replays the stream into a fresh model
    };
  }, [id]);

  const version = chat.version.value;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
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
    if (stick.current && Date.now() > pinned.current) el.scrollTop = el.scrollHeight;
  }, [version]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const model = chat.model;
  const conv = chat.conv.value || found?.conv;
  const running = conv?.status === 'running';
  const lastSteps = model.blocks.length && model.blocks[model.blocks.length - 1].type === 'steps' ? model.blocks[model.blocks.length - 1] : null;
  const waiting = approvals.value.filter((a) => a.to_conv === id);
  const focus = route.value.focusEvent;

  return html`<main class="main">
    <${ChatHead} project=${found?.project} conv=${found?.conv} />
    <div class="thread" ref=${scroller} onScroll=${onScroll}>
      <div class="thread-inner">
        ${!model.blocks.length && !running && html`<div class="thread-empty">
          <div class="empty-icon"><${Icon} name="message-square" /></div>
          <strong>Start the conversation</strong>
          <span class="dim">${found?.project?.name}: the agent works in ${conv?.worktree ? `its own worktree on ${conv.branch}` : 'the project folder'}.</span>
        </div>`}
        ${model.blocks.map((b) => html`<${Block} key=${b.key} b=${b} v=${b.v} hit=${focus != null && b.eventId === focus} active=${running && b === lastSteps && !b.done} root=${conv?.worktree || found?.project?.path} conversationId=${conv?.id} />`)}
        ${waiting.map((a) => html`<${ApprovalCard} key=${a.id} a=${a} />`)}
        ${running && html`<${Live} live=${model.live} since=${model.startedAt} />`}
      </div>
    </div>
    <${Composer} id=${id} project=${found?.project} />
  </main>`;
}
