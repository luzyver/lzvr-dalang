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
