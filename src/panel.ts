import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

// public/ sits next to src/ and dist/, so ../public works for both `tsx src/main.ts` and `node dist/main.js`.
const dir = new URL('../public/', import.meta.url);

const FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/js/api.js': ['js/api.js', 'text/javascript; charset=utf-8'],
  '/js/chat.js': ['js/chat.js', 'text/javascript; charset=utf-8'],
  '/js/dom.js': ['js/dom.js', 'text/javascript; charset=utf-8'],
  '/js/passkeys.js': ['js/passkeys.js', 'text/javascript; charset=utf-8'],
  '/icons/arrow-up.svg': ['icons/arrow-up.svg', 'image/svg+xml'],
  '/icons/chevron-down.svg': ['icons/chevron-down.svg', 'image/svg+xml'],
  '/icons/chevron-right.svg': ['icons/chevron-right.svg', 'image/svg+xml'],
  '/icons/ellipsis.svg': ['icons/ellipsis.svg', 'image/svg+xml'],
  '/icons/folder.svg': ['icons/folder.svg', 'image/svg+xml'],
  '/icons/panel-left.svg': ['icons/panel-left.svg', 'image/svg+xml'],
  '/icons/paperclip.svg': ['icons/paperclip.svg', 'image/svg+xml'],
  '/icons/plus.svg': ['icons/plus.svg', 'image/svg+xml'],
  '/icons/settings.svg': ['icons/settings.svg', 'image/svg+xml'],
  '/icons/square.svg': ['icons/square.svg', 'image/svg+xml'],
  '/icons/trash-2.svg': ['icons/trash-2.svg', 'image/svg+xml'],
  '/icons/x.svg': ['icons/x.svg', 'image/svg+xml'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

/** The shell holds no secrets and must load before a token exists, so these paths skip auth. */
export const PANEL_PATHS = new Set(Object.keys(FILES));

export function panelRoutes(app: FastifyInstance): void {
  for (const [path, [file, type]] of Object.entries(FILES)) {
    const body = readFileSync(new URL(file, dir));
    app.get(path, (_req, reply) =>
      reply
        .header('content-type', type)
        .header('cache-control', 'no-cache')
        .header('content-security-policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
        .header('x-frame-options', 'DENY')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .send(body));
  }
}
