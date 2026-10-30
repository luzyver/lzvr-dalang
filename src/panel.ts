import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

// public/ sits next to src/ and dist/, so ../public works for both `tsx src/main.ts` and `node dist/main.js`.
const dir = new URL('../public/', import.meta.url);

/** Every `ext` file in a folder of public/, so a new module or icon is served without being listed here. */
function folder(sub: string, ext: string, type: string): Record<string, [file: string, type: string]> {
  return Object.fromEntries(readdirSync(new URL(`${sub}/`, dir)).filter((f) => f.endsWith(ext)).sort()
    .map((f) => [`/${sub}/${f}`, [`${sub}/${f}`, type]]));
}

const CSP = "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'";
/**
 * The code editor's and the SQL editor's pages are the same shell under their own paths, since their CodeMirror and
 * xterm.js write their styles into <style> elements: there inline styles are allowed (inline scripts never), and the
 * rest of the panel stays strict.
 */
const CODE_CSP = CSP.replace("default-src 'self';", "default-src 'self'; style-src 'self' 'unsafe-inline';");

const FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/code': ['index.html', 'text/html; charset=utf-8'],
  '/sql': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  ...folder('js', '.js', 'text/javascript; charset=utf-8'),
  ...folder('vendor', '.js', 'text/javascript; charset=utf-8'),
  ...folder('vendor/code', '.js', 'text/javascript; charset=utf-8'),
  ...folder('vendor/code', '.css', 'text/css; charset=utf-8'),
  ...folder('css', '.css', 'text/css; charset=utf-8'),
  ...folder('icons', '.svg', 'image/svg+xml'),
  ...folder('fonts', '.woff2', 'font/woff2'),
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

/** The shell holds no secrets and must load before a token exists, so these paths skip auth. */
export const PANEL_PATHS = new Set(Object.keys(FILES));

export function panelRoutes(app: FastifyInstance): void {
  for (const [path, [file, type]] of Object.entries(FILES)) {
    const body = readFileSync(new URL(file, dir));
    // no-cache still lets the browser keep a copy: it asks each time, and an unchanged file costs a 304.
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    app.get(path, (req, reply) => {
      reply
        .header('content-type', type)
        .header('cache-control', 'no-cache')
        .header('etag', etag)
        .header('content-security-policy', path === '/code' || path === '/sql' ? CODE_CSP : CSP)
        .header('x-frame-options', 'DENY')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer');
      return req.headers['if-none-match'] === etag ? reply.code(304).send() : reply.send(body);
    });
  }
}
