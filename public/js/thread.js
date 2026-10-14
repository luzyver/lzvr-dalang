// Rendering a chat's thread: prompts, answers, foldable groups of tool steps, notes and what is running now.
import { Component } from '../vendor/preact.js';
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { Icon, Spinner } from './ui.js';
import { Markdown } from './markdown.js';
import { DiffView, diffStats } from './diff.js';
import { copyText } from './code.js';
import { clock, duration, plural, tokens } from './format.js';

/** Re-renders every second: for "running for 2m 14s". */
export function Elapsed({ since }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return since ? duration(Date.now() - since).replace(/\.\ds$/, 's') : '';
}

const CHANGE_LABEL = { add: 'Created', write: 'Wrote', delete: 'Deleted', update: 'Edited', edit: 'Edited' };
const CHANGE_ICON = { add: 'file-plus', write: 'file-plus', delete: 'file-minus' };
const slashes = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
/** `path` relative to the folder the chat works in, when it lies inside it. */
const relative = (path, root) => {
  const p = slashes(path);
  const r = slashes(root);
  return r && p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p;
};

function DiffStat({ add, del }) {
  return html`<span class="diffstat">${add > 0 && html`<b class="add">+${add}</b>`}${del > 0 && html`<b class="del">−${del}</b>`}</span>`;
}

function Step({ s, root }) {
  const [open, setOpen] = useState(false);
  let icon;
  let label;
  let detail;
  let side = null;
  let body = null;
  if (s.kind === 'command') {
    icon = 'terminal';
    label = 'Ran';
    detail = s.command || 'command';
    side = s.exit == null ? null : html`<span class=${cx('exit', s.exit === 0 ? 'ok' : 'bad')}><${Icon} name=${s.exit === 0 ? 'check' : 'x'} />exit ${s.exit}</span>`;
    body = html`<div class="step-body"><code class="step-cmd">$ ${s.command}</code>${s.output && html`<pre class="output">${s.output.slice(-4000)}</pre>`}</div>`;
  } else if (s.kind === 'file') {
    icon = CHANGE_ICON[s.change] || 'file-pen';
    label = CHANGE_LABEL[s.change] || 'Changed';
    detail = s.movePath ? `${relative(s.path, root)} → ${relative(s.movePath, root)}` : relative(s.path, root);
    side = html`<${DiffStat} ...${diffStats(s.diff)} />`;
    body = s.diff ? html`<div class="step-body"><div class="diff compact"><${DiffView} diff=${s.diff} path=${s.movePath || s.path} /></div></div>` : null;
  } else if (s.kind === 'reasoning') {
    icon = 'lightbulb';
    label = 'Thought';
    detail = s.text.split('\n')[0].slice(0, 160);
    body = html`<div class="step-body"><div class="reasoning">${s.text}</div></div>`;
  } else {
    icon = 'wrench';
    label = s.tool;
    detail = s.text;
  }
  return html`<li class=${cx('step', open && 'open', body && 'expandable')}>
    <button class="step-line" disabled=${!body} aria-expanded=${body ? open : undefined} onClick=${() => setOpen(!open)}>
      <${Icon} name=${icon} /><span class="step-label">${label}</span><code title=${detail}>${detail}</code>${side}
    </button>
    ${open && body}
  </li>`;
}

function Steps({ b, active, root }) {
  // Open while the agent works on it, folded once done; a click overrides either.
  const [manual, setManual] = useState(null);
  const open = manual ?? active;
  const files = b.items.filter((s) => s.kind === 'file').length;
  const took = b.end - b.start;
  return html`<div class=${cx('turn', open && 'open')}>
    <button class="turn-head" aria-expanded=${open} onClick=${() => setManual(!open)}>
      <${Icon} name="chevron-right" class="caret" />
      ${active ? html`<${Spinner} class="ok" /><span>Working</span>` : html`<span>${took >= 1000 ? `Worked for ${duration(took).replace(/\.\ds$/, 's')}` : 'Worked'}</span>`}
      <span class="dim">· ${plural(b.items.length, 'step')}${files ? ` · ${plural(files, 'file')} changed` : ''}</span>
    </button>
    ${open && html`<ol class="steps">${b.items.map((s) => html`<${Step} key=${s.id} s=${s} root=${root} />`)}</ol>`}
  </div>`;
}

function Agent({ b }) {
  const u = b.usage;
  return html`<div class="msg agent">
    <${Markdown} text=${b.text} />
    <div class="msg-actions">
      <button class="icon-btn sm" aria-label="Copy answer" title="Copy as Markdown" onClick=${() => copyText(b.text)}><${Icon} name="copy" /></button>
      <span class="msg-meta">${clock(b.at)}${u && ` · ${tokens(u.input_tokens)} in · ${tokens(u.output_tokens)} out`}</span>
    </div>
  </div>`;
}

/** One block; redraws only when the block changed (`v`) or its marks did. */
export class Block extends Component {
  shouldComponentUpdate(next) {
    return next.b !== this.props.b || next.v !== this.props.v || next.hit !== this.props.hit || next.active !== this.props.active;
  }

  render({ b, hit, active, root }) {
    let body;
    if (b.type === 'user') {
      body = html`<div class="msg user"><div class="bubble">${b.text}</div><div class="msg-meta">${clock(b.at)}</div></div>`;
    } else if (b.type === 'agent') body = html`<${Agent} b=${b} v=${b.v} />`;
    else if (b.type === 'steps') body = html`<${Steps} b=${b} v=${b.v} active=${active} root=${root} />`;
    else body = html`<div class=${cx('note', b.tone)}><${Icon} name=${b.tone === 'err' ? 'circle-alert' : b.tone === 'warn' ? 'triangle-alert' : 'info'} /><span>${b.text}</span></div>`;
    return html`<div class=${cx('block', hit && 'hit')} data-event=${b.eventId}>${body}</div>`;
  }
}

export function Live({ live, since }) {
  return html`<div class="live">
    <${Spinner} />
    <span>${live?.label || 'Working'}</span>
    ${live?.detail && html`<code title=${live.detail}>${live.detail}</code>`}
    ${since && html`<span class="dim">· <${Elapsed} since=${since} /></span>`}
  </div>`;
}
