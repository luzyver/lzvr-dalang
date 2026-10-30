// Dalang panel: the app shell. Preact components (js/*) render from signals (js/store.js); there is no build step.
// Every server-provided string is rendered as text, never parsed as HTML (highlighted code is the one exception: see
// js/highlight.js).
import { render } from './vendor/preact.js';
import { useEffect, useState } from './vendor/preact-hooks.js';
import { html, cx } from './js/lib.js';
import { ConfirmDialog, Toasts } from './js/ui.js';
import { isAdmin, openChat, route, toast, ui } from './js/store.js';
import './js/theme.js';
import { bootSession, session } from './js/session.js';
import { Login } from './js/login.js';
import { AddProjectModal, Sidebar } from './js/sidebar.js';
import { ChatView } from './js/chat-view.js';
import { Inspector } from './js/inspector.js';
import { SchedulesView } from './js/schedules.js';
import { ApprovalsView } from './js/approvals.js';
import { SshHostsView } from './js/ssh-hosts.js';
import { Home } from './js/home.js';
import { CommandPalette } from './js/palette.js';
import { SettingsModal } from './js/settings.js';

function Shell() {
  const r = route.value;
  const inChat = r.view === 'chat';
  const inspector = inChat && ui.inspectorOpen.value;
  const close = () => { ui.sidebarOpen.value = false; ui.inspectorOpen.value = false; };
  return html`<div class=${cx('app', ui.sidebarHidden.value && 'no-side', !inspector && 'no-insp', inspector && ui.inspectorMax.value && 'insp-max', ui.sidebarOpen.value && 'side-open')}
    style=${{ '--insp-w': `${ui.inspectorWidth.value}px` }}>
    <${Sidebar} />
    ${inChat ? html`<${ChatView} key=${r.id} id=${r.id} focusEvent=${r.focusEvent} />`
      : r.view === 'schedules' ? html`<${SchedulesView} />`
        : r.view === 'approvals' ? html`<${ApprovalsView} />`
        : r.view === 'ssh' && isAdmin.value ? html`<${SshHostsView} />`
          : html`<${Home} />`}
    ${inChat && html`<${Inspector} id=${r.id} />`}
    <div class="scrim" onClick=${close}></div>
    <${CommandPalette} />
    <${SettingsModal} />
    <${AddProjectModal} />
  </div>`;
}

/** The code editor fills its own tab; its module (with CodeMirror and xterm.js) loads only there. */
function CodeTab({ id }) {
  const [mod, setMod] = useState(null);
  useEffect(() => { import('./js/code-editor.js').then(setMod, (e) => toast(`the code editor did not load: ${e.message}`, 'err')); }, []);
  return mod ? html`<${mod.CodeEditor} id=${id} />` : html`<div class="boot"></div>`;
}

/** The SQL editor fills its own tab too, with the same CodeMirror bundle. */
function SqlTab() {
  const [mod, setMod] = useState(null);
  useEffect(() => { import('./js/sql-editor.js').then(setMod, (e) => toast(`the SQL editor did not load: ${e.message}`, 'err')); }, []);
  return mod ? html`<${mod.SqlEditor} />` : html`<div class="boot"></div>`;
}

function App() {
  const s = session.value;
  const r = route.value;
  const main = s !== 'in' ? (s === 'out' ? html`<${Login} />` : html`<div class="boot"></div>`)
    : r.view === 'code' ? html`<${CodeTab} id=${r.id} />` : r.view === 'sql' ? html`<${SqlTab} />` : html`<${Shell} />`;
  return html`${main}<${Toasts} /><${ConfirmDialog} />`;
}

// ---------- boot ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // A tapped notification opens its chat in the panel that is already open.
  navigator.serviceWorker.addEventListener('message', (m) => {
    if (m.data && m.data.convId && session.value === 'in' && route.value.view !== 'code' && route.value.view !== 'sql') openChat(m.data.convId);
  });
}
render(html`<${App} />`, document.getElementById('root'));
bootSession();
