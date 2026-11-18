// Which links in an agent's answer are files of the chat, and the download each becomes. No imports: the tests load it.

// A full path, as the agents are told to link a file (see filesGuide in templates.ts): /home/me/x.pdf, or on Windows
// D:\state\x.pdf and D:/state/x.pdf.
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

export const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+|sandbox:[^\s)]+|<(?:sandbox:|\/|[A-Za-z]:[\\/])[^>]+>|\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

const OWN_DOWNLOAD = /^\/api\/conversations\/[^/]+\/files\/download$/;

/** A full URL to this panel's own download route (an agent may write it out): a plain link would carry no token. */
export function ownDownload(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const path = u.searchParams.get('path');
  if (u.origin !== location.origin || !OWN_DOWNLOAD.test(u.pathname) || !path) return null;
  return { href: u.pathname + u.search, filename: path.split(/[\\/]/).pop() || 'download' };
}

export function localDownload(path, conversationId) {
  if (/^https?:\/\//i.test(path)) return ownDownload(path);
  if (!conversationId) return null;
  if (path.startsWith('<') && path.endsWith('>')) path = path.slice(1, -1);
  if (path.startsWith('sandbox:')) path = path.slice('sandbox:'.length);
  if (!path.startsWith('/') && !WINDOWS_PATH.test(path)) return null;
  // A line reference after the file: path:12, path:12:5, path#L12, path#L12C5, path#L12-L20.
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/, '');
  let filename = path.split(/[\\/]/).pop() || 'download';
  try { filename = decodeURIComponent(filename); } catch { /* keep the literal name */ }
  const query = new URLSearchParams({ path });
  return { href: `/api/conversations/${encodeURIComponent(conversationId)}/files/download?${query}`, filename };
}
