import { beforeAll, describe, expect, it, vi } from 'vitest';

// The panel modules read these browser globals when they load.
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
vi.stubGlobal('innerWidth', 1440);
vi.stubGlobal('innerHeight', 900);
vi.stubGlobal('addEventListener', () => {});
vi.stubGlobal('history', { replaceState() {} });
vi.stubGlobal('location', { pathname: '/', search: '' });

/* eslint-disable @typescript-eslint/no-explicit-any */
let targetFree: any;
beforeAll(async () => {
  // @ts-expect-error The panel modules are plain JavaScript.
  ({ targetFree } = await import('../public/js/mr-base.js'));
});

describe('the Merge Request target in the panel', () => {
  const url = 'https://github.com/acme/app/pull/7';
  it('may be picked without a Merge Request, and again once it is merged or closed', () => {
    expect(targetFree(null, undefined)).toBe(true);
    expect(targetFree(url, 'merged')).toBe(true);
    expect(targetFree(url, 'closed')).toBe(true);
  });
  it('stays while it is open, a draft, or its state is not known', () => {
    for (const state of ['open', 'draft', null, undefined]) expect(targetFree(url, state)).toBe(false);
  });
});
