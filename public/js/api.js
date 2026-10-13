let unauthorizedHandler = () => {};
export const setUnauthorizedHandler = (fn) => { unauthorizedHandler = fn; };
export const handleUnauthorized = () => unauthorizedHandler();

export const tokenStore = {
  get() { try { return localStorage.getItem('lzvr_token') || ''; } catch { return ''; } },
  set(t) { try { localStorage.setItem('lzvr_token', t); } catch { /* private mode: login lasts until reload */ memoryToken = t; } },
  clear() { try { localStorage.removeItem('lzvr_token'); } catch { /* ignore */ } memoryToken = ''; },
};
let memoryToken = '';
export const currentToken = () => tokenStore.get() || memoryToken;

export class Unauthorized extends Error {}

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = { authorization: `Bearer ${currentToken()}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) { handleUnauthorized(); throw new Unauthorized(); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

export async function publicApi(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}
