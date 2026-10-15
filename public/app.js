// Dalang panel: the app shell. Preact components (js/*) render from signals (js/store.js); there is no build step.
// Every server-provided string is rendered as text, never parsed as HTML (highlighted code is the one exception: see
// js/highlight.js).
import { render } from './vendor/preact.js';
import { html, cx } from './js/lib.js';
import { ConfirmDialog, Toasts } from './js/ui.js';
import { openChat, route, ui } from './js/store.js';
import './js/theme.js';
import { session, startSession } from './js/session.js';
import { Login } from './js/login.js';
import { AddProjectModal, Sidebar } from './js/sidebar.js';
import { ChatView } from './js/chat-view.js';
import { Inspector } from './js/inspector.js';
import { SchedulesView } from './js/schedules.js';
import { ApprovalsView } from './js/approvals.js';
import { Home } from './js/home.js';
import { CommandPalette } from './js/palette.js';
import { SettingsModal } from './js/settings.js';

function Shell() {
  const r = route.value;
  const inChat = r.view === 'chat';
  const inspector = inChat && ui.inspectorOpen.value;
  const close = () => { ui.sidebarOpen.value = false; ui.inspectorOpen.value = false; };
  return html`<div class=${cx('app', ui.sidebarHidden.value && 'no-side', !inspector && 'no-insp', ui.sidebarOpen.value && 'side-open')}>
    <${Sidebar} />
    ${inChat ? html`<${ChatView} key=${r.id} id=${r.id} focusEvent=${r.focusEvent} />`
      : r.view === 'schedules' ? html`<${SchedulesView} />`
        : r.view === 'approvals' ? html`<${ApprovalsView} />`
          : html`<${Home} />`}
    ${inChat && html`<${Inspector} id=${r.id} />`}
    <div class="scrim" onClick=${close}></div>
    <${CommandPalette} />
    <${SettingsModal} />
    <${AddProjectModal} />
  </div>`;
}

function App() {
  const s = session.value;
  return html`${s === 'in' ? html`<${Shell} />` : s === 'out' ? html`<${Login} />` : html`<div class="boot"></div>`}<${Toasts} /><${ConfirmDialog} />`;
}

// ---------- boot ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // A tapped notification opens its chat in the panel that is already open.
  navigator.serviceWorker.addEventListener('message', (m) => {
    if (m.data && m.data.convId && session.value === 'in') openChat(m.data.convId);
  });
}
render(html`<${App} />`, document.getElementById('root'));
if (session.value === 'checking') startSession();
