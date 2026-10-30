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
    expect((await app.inject({ url: '/css/base.css' })).headers['content-type']).toContain('text/css');
    const mf = await app.inject({ url: '/manifest.webmanifest' });
    expect(mf.json()).toMatchObject({ display: 'standalone', start_url: '/' });
    expect((await app.inject({ url: '/sw.js' })).headers['content-type']).toContain('javascript');
    expect((await app.inject({ url: '/icon.svg' })).headers['content-type']).toContain('image/svg+xml');
  });

  it('serves every module the panel imports, with the names it imports', async () => {
    const { app } = setupApp();
    const seen = new Set<string>();
    const queue = ['/app.js', '/js/code-editor.js']; // the editor's module loads with import(), so it is walked too
    // Our modules export one declaration at a time; the vendored (minified) ones end with `export{a as b,...}`.
    const exports = (src: string, name: string) => new RegExp(`^export (async )?(function|const|class|let) ${name}\\b`, 'm').test(src)
      || [...src.matchAll(/export\s*\{([^}]*)\}/g)].some(([, list = '']) => list.split(',').some((e) => e.trim().split(/\s+as\s+/).pop() === name))
      || (name === 'default' && /(^|[;}])export default\b/m.test(src));
    while (queue.length) {
      const url = queue.pop()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      // import x from '…'; import { a, b as c } from '…'; import x, { a } from '…'; import '…'; and the vendored from"./x.js"
      const imports = [
        ...[...res.body.matchAll(/^import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]+)\})?\s*(?:from\s*)?'(\.[^']+)';/gm)]
          .map(([, def, names = '', path = '']) => ({ path, names: [...(def ? ['default'] : []), ...names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!).filter(Boolean)] })),
        ...[...res.body.matchAll(/from\s*"(\.\/[^"]+)"/g)].map(([, path = '']) => ({ path, names: [] as string[] })),
      ];
      for (const { path, names } of imports) {
        const target = new URL(path, `http://x${url}`).pathname;
        const src = (await app.inject({ url: target })).body;
        for (const name of names) expect(exports(src, name), `${url} imports ${name} from ${target}`).toBe(true);
        queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(20);
    expect(seen).toContain('/vendor/preact.js');
  });

  it('serves the highlight.js languages the panel loads on demand, and the fonts', async () => {
    const { app } = setupApp();
    const src = (await app.inject({ url: '/js/highlight.js' })).body;
    const langs = JSON.parse(/const LANGS = (\[[^\]]+\])/.exec(src)![1]!.replace(/'/g, '"').replace(/\s+/g, ' '));
    expect(langs.length).toBeGreaterThan(10);
    for (const l of ['hljs', ...langs.map((x: string) => `hljs-${x}`)]) expect((await app.inject({ url: `/vendor/${l}.js` })).statusCode, l).toBe(200);
    const font = await app.inject({ url: '/fonts/Geist-Variable.woff2' });
    expect(font.statusCode).toBe(200);
    expect(font.headers['content-type']).toBe('font/woff2');
  });

  it('answers an unchanged file with 304', async () => {
    const { app } = setupApp();
    const first = await app.inject({ url: '/css/base.css' });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[\w-]+"$/);
    const again = await app.inject({ url: '/css/base.css', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('locks the shell down with a strict CSP', async () => {
    const { app } = setupApp();
    const h = (await app.inject({ url: '/' })).headers;
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).not.toContain('unsafe-inline');
    expect(h['x-frame-options']).toBe('DENY');
    // The code editor's page alone lets CodeMirror and xterm.js write <style> elements; scripts stay locked down.
    const code = (await app.inject({ url: '/code' })).headers['content-security-policy'] as string;
    expect(code).toContain("style-src 'self' 'unsafe-inline'");
    expect(code).not.toMatch(/script-src[^;]*unsafe/);
    expect(code).toContain("frame-ancestors 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  it('keeps everything else behind the token', async () => {
    const { app } = setupApp();
    expect((await app.inject({ url: '/api/projects' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/nope' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/nope', headers: AUTH })).statusCode).toBe(404);
  });
});
