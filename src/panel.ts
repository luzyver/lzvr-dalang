import { readdirSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

// public/ sits next to src/ and dist/, so ../public works for both `tsx src/main.ts` and `node dist/main.js`.
const dir = new URL('../public/', import.meta.url);

/** Every `ext` file in a folder of public/, so a new module or icon is served without being listed here. */
function folder(sub: string, ext: string, type: string): Record<string, [file: string, type: string]> {
  return Object.fromEntries(readdirSync(new URL(`${sub}/`, dir)).filter((f) => f.endsWith(ext)).sort()
    .map((f) => [`/${sub}/${f}`, [`${sub}/${f}`, type]]));
}

const FILES: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  ...folder('js', '.js', 'text/javascript; charset=utf-8'),
  ...folder('icons', '.svg', 'image/svg+xml'),
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
