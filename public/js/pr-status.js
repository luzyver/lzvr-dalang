// The chat's open pull request / Merge Request as the forge sees it: open, merged or closed, its CI checks, its review,
// what reviewers wrote (which can go to the agent as a prompt), and merging it.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Icon, Seg, Spinner } from './ui.js';
import { guarded } from './store.js';
import { dateTime, plural } from './format.js';
import { askAgent } from './git-sync.js';

const STATE = { open: ['Open', 'accent'], draft: ['Draft', ''], merged: ['Merged', 'ok'], closed: ['Closed', 'err'] };
const REVIEW = { approved: ['Approved', 'ok'], changes_requested: ['Changes requested', 'warn'], review_required: ['Review required', ''] };
const CHECK = { pass: ['circle-check', 'ok'], fail: ['circle-x', 'err'], pending: ['circle-dashed', 'warn'], skipped: ['circle-dashed', 'dim'] };

const reviewPrompt = (s) => `Address the review comments on ${s.url}:

${s.comments.map((c) => `- ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}${c.kind ? ` (${c.kind})` : ''}: ${c.body.trim().replace(/\n+/g, ' ')}`).join('\n')}

Make the changes they ask for where they are right, and tell me which ones you did not take and why.`;

const failingPrompt = (s) => `These CI checks fail on ${s.url}:
${s.checks.filter((c) => c.state === 'fail').map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ''}`).join('\n')}

Find out why (run the same checks locally where you can) and fix it.`;

/** `onState`: told the state ('open', 'draft', 'merged', 'closed') each time it is read, null when it could not be. */
export function PrStatus({ id, url, onDone, onState }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [method, setMethod] = useState('squash');
  const [comments, setComments] = useState(false);
  const load = () => api(`/api/conversations/${id}/git/pull-request`).then((r) => { setS(r); setError(''); onState?.(r.state); }, (e) => { setError(e.message); onState?.(null); });
  useEffect(() => { setS(null); load(); }, [id, url]);

  const merge = guarded(async () => {
    if (!await confirmDialog({
      title: 'Merge it on the forge?',
      message: `${s.title}\n\n${method === 'squash' ? 'All its commits become one commit' : method === 'rebase' ? 'Its commits are replayed onto the target branch' : 'A merge commit joins it in'}.`,
      confirmText: 'Merge',
    })) return;
    const r = await api(`/api/conversations/${id}/git/pull-request/merge`, { method: 'POST', body: { method } });
    setS(r);
    onState?.(r.state);
    await onDone('Merged');
  });

  if (error) {
    return html`<div class="pr-status"><div class="row"><span class="warn small ellip" title=${error}><${Icon} name="circle-alert" class="tiny" /> Could not read its status: ${error}</span>
      <div class="spacer"></div><${AsyncButton} class="icon-btn sm" icon="refresh-cw" title="Try again" onClick=${load} /></div></div>`;
  }
  if (!s) return html`<div class="pr-status dim small"><${Spinner} /> Asking the forge…</div>`;
  const [stateLabel, stateTone] = STATE[s.state] || [s.state, ''];
  const review = REVIEW[s.review];
  const failing = s.checks.filter((c) => c.state === 'fail').length;
  const pending = s.checks.filter((c) => c.state === 'pending').length;
  const live = s.state === 'open' || s.state === 'draft';
  return html`<div class="pr-status">
    <div class="pr-pills">
      <span class=${cx('pill', stateTone)}>${stateLabel}</span>
      ${review && html`<span class=${cx('pill', review[1])}>${review[0]}</span>`}
      ${live && s.mergeable === false && html`<span class="pill err" title="The forge will not merge it yet: conflicts, failing required checks or missing approvals">Blocked</span>`}
      ${s.checks.length > 0 && html`<span class=${cx('pill', failing ? 'err' : pending ? 'warn' : 'ok')}>${failing ? `${failing} failing` : pending ? `${pending} running` : 'checks pass'}</span>`}
      <div class="spacer"></div>
      <${AsyncButton} class="icon-btn sm" icon="refresh-cw" title="Ask the forge again" onClick=${load} />
    </div>
    ${s.checks.length > 0 && html`<div class="pr-checks">${s.checks.map((c) => {
      const [icon, tone] = CHECK[c.state];
      return html`<div class="pr-check"><${Icon} name=${icon} class=${cx('tiny', tone)} />
        ${c.url ? html`<a href=${c.url} target="_blank" rel="noopener noreferrer" class="ellip">${c.name}</a>` : html`<span class="ellip">${c.name}</span>`}</div>`;
    })}</div>`}
    ${s.comments.length > 0 && html`<div class="pr-comments">
      <button class="btn ghost sm" onClick=${() => setComments(!comments)}><${Icon} name=${comments ? 'chevron-down' : 'chevron-right'} class="tiny" />${plural(s.comments.length, 'comment')}</button>
      ${comments && s.comments.map((c, i) => html`<div key=${i} class="pr-comment">
        <div class="dim small"><strong>${c.author}</strong>${c.kind ? ` · ${c.kind}` : ''}${c.path ? html` · <span class="mono">${c.path}${c.line ? `:${c.line}` : ''}</span>` : ''} · ${dateTime(c.date)}</div>
        <div class="pr-comment-body">${c.body}</div>
      </div>`)}
    </div>`}
    ${live && html`<div class="row pr-actions">
      ${s.comments.length > 0 && html`<${AsyncButton} class="btn ghost sm" icon="bot" title="Send the comments to the chat's agent as a prompt" onClick=${guarded(() => askAgent(id, reviewPrompt(s)))}>Address comments<//>`}
      ${failing > 0 && html`<${AsyncButton} class="btn ghost sm" icon="bot" title="Ask the chat's agent to fix the failing checks" onClick=${guarded(() => askAgent(id, failingPrompt(s)))}>Fix checks<//>`}
      <div class="spacer"></div>
      <${Seg} small label="Merge method" value=${method} onChange=${setMethod} options=${[['squash', 'Squash'], ['merge', 'Merge'], ['rebase', 'Rebase']]} />
      <${AsyncButton} class="btn primary sm" icon="git-merge" disabled=${s.state === 'draft'} title=${s.state === 'draft' ? 'A draft is not merged' : 'Merge it on the forge'} onClick=${merge}>Merge<//>
    </div>`}
  </div>`;
}
