import { beforeAll, describe, expect, it, vi } from 'vitest';

type VNode = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
let Markdown: (p: { text: string; conversationId: string }) => VNode;

beforeAll(async () => {
  // The renderer's imports reach the panel's store, which reads the window as it loads.
  const store: Record<string, string> = {};
  vi.stubGlobal('innerWidth', 1400);
  vi.stubGlobal('location', new URL('https://dalang.test/'));
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
  ({ Markdown } = await import('../public/js/markdown.js' as string));
});

/** What a rendered answer shows, in order: text as is, a link as <label|class or kind>. */
function shown(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(shown).join('');
  if (typeof node !== 'object') return String(node);
  const v = node as VNode;
  const inner = shown(v.props.children);
  if (v.type !== 'a') return inner;
  return `<${inner}|${v.props.class ?? (v.props.download ? 'download' : 'external')}>`;
}
const render = (text: string) => shown(Markdown({ text, conversationId: 'c1' }));

describe('links in an answer', () => {
  it('shows a file link once, as a download, with Open only for an HTML file', () => {
    expect(render('Ini [data.xlsx](/data/state/chat-files/c1/data.xlsx) ya')).toBe('Ini <data.xlsx|download> ya');
    expect(render('[laporan](/data/state/chat-files/c1/laporan.html).')).toBe('<laporan|download><Open|file-open>.');
  });

  it('keeps a web link a link and leaves any other target as written', () => {
    expect(render('[situs](https://example.com/a.html)')).toBe('<situs|external>');
    expect(render('[c](data.xlsx)')).toBe('[c](data.xlsx)');
  });
});
