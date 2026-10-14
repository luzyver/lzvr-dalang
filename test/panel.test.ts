import { describe, expect, it } from 'vitest';
import { AUTH } from './helpers.js';
import { setupApp } from './setup-app.js';

describe('panel', () => {
  it('serves the app shell without a token', async () => {
    const { app } = setupApp();
    const html = await app.inject({ url: '/' });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('<title>');
    expect(html.body).toContain('/app.js');
  });

  it('serves script, styles, manifest, service worker and icon', async () => {
    const { app } = setupApp();
    const js = await app.inject({ url: '/app.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect((await app.inject({ url: '/app.css' })).headers['content-type']).toContain('text/css');
    const mf = await app.inject({ url: '/manifest.webmanifest' });
    expect(mf.json()).toMatchObject({ display: 'standalone', start_url: '/' });
    expect((await app.inject({ url: '/sw.js' })).headers['content-type']).toContain('javascript');
    expect((await app.inject({ url: '/icon.svg' })).headers['content-type']).toContain('image/svg+xml');
  });

  it('serves every module the panel imports, with the names it imports', async () => {
    const { app } = setupApp();
    const seen = new Set<string>();
    const queue = ['/app.js'];
    while (queue.length) {
      const url = queue.pop()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      for (const [, names = '', path = ''] of res.body.matchAll(/^import \{([^}]+)\} from '(\.[^']+)';/gm)) {
        const target = new URL(path, `http://x${url}`).pathname;
        const src = (await app.inject({ url: target })).body;
        for (const name of names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          expect(src, `${url} imports ${name} from ${target}`).toMatch(new RegExp(`^export (async )?(function|const|class|let) ${name}\\b`, 'm'));
        }
        queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('locks the shell down with a strict CSP', async () => {
    const { app } = setupApp();
    const h = (await app.inject({ url: '/' })).headers;
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).not.toContain('unsafe-inline');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  it('keeps everything else behind the token', async () => {
    const { app } = setupApp();
    expect((await app.inject({ url: '/api/projects' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/nope' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/nope', headers: AUTH })).statusCode).toBe(404);
  });
});
