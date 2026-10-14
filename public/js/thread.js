// Rendering a chat's thread: prompts, answers, foldable groups of tool steps, notes and what is running now.
import { Component } from '../vendor/preact.js';
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { Icon, Modal, Seg, Spinner } from './ui.js';
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

/** Previous / next step of the same kind, a click (or ← →) away; `onKeyDown` goes on the dialog. */
function useStepNav(list, current, onPick) {
  const i = list.indexOf(current);
  const step = (by) => { const f = list[i + by]; if (f) onPick(f.id); };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); step(1); }
  };
  const what = current.kind === 'file' ? 'file' : 'command';
  const nav = list.length > 1 && html`<div class="diff-nav">
    <button class="icon-btn sm" aria-label=${`Previous ${what}`} title=${`Previous ${what} (←)`} disabled=${i <= 0} onClick=${() => step(-1)}><${Icon} name="chevron-left" /></button>
    <span class="dim small">${i + 1} / ${list.length}</span>
    <button class="icon-btn sm" aria-label=${`Next ${what}`} title=${`Next ${what} (→)`} disabled=${i >= list.length - 1} onClick=${() => step(1)}><${Icon} name="chevron-right" /></button>
  </div>`;
  return [nav, onKeyDown];
}

const ExitCode = ({ exit }) => (exit == null ? null
  : html`<span class=${cx('exit', exit === 0 ? 'ok' : 'bad')}><${Icon} name=${exit === 0 ? 'check' : 'x'} />exit ${exit}</span>`);

/** A file step's diff in a dialog, like the Changes tab's, with the turn's other changed files a click away. */
function StepDiffDialog({ list, current, root, onPick, onClose }) {
  const [mode, setMode] = useState(innerWidth > 1100 ? 'split' : 'unified');
  const [nav, onKeyDown] = useStepNav(list, current, onPick);
  const path = current.movePath || current.path;
  const title = current.movePath ? `${relative(current.path, root)} → ${relative(current.movePath, root)}` : relative(current.path, root);
  return html`<div class="diff-dialog" tabindex="-1" onKeyDown=${onKeyDown}>
    <div class="diff-dialog-head">
      <${Icon} name=${CHANGE_ICON[current.change] || 'file-pen'} />
      <code class="diff-dialog-path" title=${title}>${title}</code>
      <${DiffStat} ...${diffStats(current.diff)} />
      <div class="spacer"></div>
      <${Seg} small label="Diff layout" value=${mode} onChange=${setMode} options=${[['unified', 'Unified'], ['split', 'Split']]} />
      ${nav}
      <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
    </div>
    <div class="diff-dialog-body"><${DiffView} diff=${current.diff} path=${path} mode=${mode} /></div>
  </div>`;
}

/** A command step and its output in a dialog, with the turn's other commands a click away. */
function StepCommandDialog({ list, current, onPick, onClose }) {
  const [nav, onKeyDown] = useStepNav(list, current, onPick);
  return html`<div class="diff-dialog" tabindex="-1" onKeyDown=${onKeyDown}>
    <div class="diff-dialog-head">
      <${Icon} name="terminal" />
      <code class="diff-dialog-path cmd" title=${current.command}>${current.command || 'command'}</code>
      <${ExitCode} exit=${current.exit} />
      <div class="spacer"></div>
      <button class="icon-btn sm" aria-label="Copy command" title="Copy command" onClick=${() => copyText(current.command || '')}><${Icon} name="copy" /></button>
      ${nav}
      <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
    </div>
    <div class="diff-dialog-body cmd-body">
      <code class="step-cmd">$ ${current.command}</code>
      ${current.output ? html`<pre class="output">${current.output}</pre>` : html`<div class="diff-empty">No output.</div>`}
    </div>
  </div>`;
}

function Step({ s, root, onOpen }) {
  const [open, setOpen] = useState(false);
  let icon;
  let label;
  let detail;
  let side = null;
  let body = null;
  let pops = false; // opens in a dialog rather than inline
  if (s.kind === 'command') {
    icon = 'terminal';
    label = 'Ran';
    detail = s.command || 'command';
    side = html`<${ExitCode} exit=${s.exit} />`;
    pops = true;
  } else if (s.kind === 'file') {
    icon = CHANGE_ICON[s.change] || 'file-pen';
    label = CHANGE_LABEL[s.change] || 'Changed';
    detail = s.movePath ? `${relative(s.path, root)} → ${relative(s.movePath, root)}` : relative(s.path, root);
    side = html`<${DiffStat} ...${diffStats(s.diff)} />`;
    pops = !!s.diff;
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
  if (pops) return html`<li class="step expandable">
    <button class="step-line" aria-haspopup="dialog" onClick=${() => onOpen(s.id)}>
      <${Icon} name=${icon} /><span class="step-label">${label}</span><code title=${detail}>${detail}</code>${side}
    </button>
  </li>`;
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
  const [viewing, setViewing] = useState(null);
  const open = manual ?? active;
  const changed = b.items.filter((s) => s.kind === 'file');
  const files = changed.length;
  const current = b.items.find((s) => s.id === viewing);
  // the dialog steps through the turn's steps of the same kind
  const list = current ? b.items.filter((s) => s.kind === current.kind && (s.kind === 'command' || s.diff)) : [];
  const took = b.end - b.start;
  return html`<div class=${cx('turn', open && 'open')}>
    <button class="turn-head" aria-expanded=${open} onClick=${() => setManual(!open)}>
      <${Icon} name="chevron-right" class="caret" />
      ${active ? html`<${Spinner} class="ok" /><span>Working</span>` : html`<span>${took >= 1000 ? `Worked for ${duration(took).replace(/\.\ds$/, 's')}` : 'Worked'}</span>`}
      <span class="dim">· ${plural(b.items.length, 'step')}${files ? ` · ${plural(files, 'file')} changed` : ''}</span>
    </button>
    ${open && html`<ol class="steps">${b.items.map((s) => html`<${Step} key=${s.id} s=${s} root=${root} onOpen=${setViewing} />`)}</ol>`}
    <${Modal} open=${!!current} label=${current?.kind === 'command' ? 'Command' : 'Diff'} class="diff-modal" onClose=${() => setViewing(null)}>
      ${current && (current.kind === 'command'
        ? html`<${StepCommandDialog} list=${list} current=${current} onPick=${setViewing} onClose=${() => setViewing(null)} />`
        : html`<${StepDiffDialog} list=${list} current=${current} root=${root} onPick=${setViewing} onClose=${() => setViewing(null)} />`)}
    <//>
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
