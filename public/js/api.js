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
    let detail;
    try { detail = await res.json(); msg = detail.error || msg; } catch { /* not json */ }
    throw Object.assign(new Error(msg), { status: res.status, detail });
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

/** A file from the API as a Blob: an <img> or a link cannot send the bearer token itself. */
export async function fetchBlob(path) {
  const res = await fetch(path, { headers: { authorization: `Bearer ${currentToken()}` } });
  if (res.status === 401) { handleUnauthorized(); throw new Unauthorized(); }
  if (!res.ok) {
    let message = res.statusText;
    try { message = (await res.json()).error || message; } catch { /* not JSON */ }
    throw Object.assign(new Error(message), { status: res.status });
  }
  return res.blob();
}

export async function downloadFile(path, filename) {
  const url = URL.createObjectURL(await fetchBlob(path));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
