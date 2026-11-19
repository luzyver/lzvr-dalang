// Connect ClickUp (Settings → MCP → ClickUp): ClickUp sends the sign-in back to the panel itself, as
// /?code=…&state=cu_…, and the page hands the code to the server with the person's own sign-in.
import { api } from './api.js';
import { openSettings, toast } from './store.js';

/** Opens ClickUp's sign-in in this tab; it comes back to the panel. */
export async function connectClickUp() {
  const { url } = await api('/api/settings/clickup/oauth/start', { method: 'POST' });
  location.href = url;
}

/** Finishes a sign-in that came back, if this page load is one, and shows Settings → MCP. */
export async function finishClickUpSignIn() {
  const q = new URLSearchParams(location.search);
  const state = q.get('state');
  if (!state || !state.startsWith('cu_')) return;
  const code = q.get('code');
  history.replaceState(null, '', `${location.pathname}${location.hash}`); // the code is good once: not kept in the address
  try {
    if (!code) throw new Error(q.get('error_description') || q.get('error') || 'ClickUp sent no code');
    await api('/api/settings/clickup/oauth/finish', { method: 'POST', body: { code, state } });
    toast('ClickUp connected');
  } catch (e) {
    toast(`ClickUp was not connected: ${e.message}`, 'err');
  }
  openSettings('mcp');
}
