import { fileURLToPath } from 'node:url';
import type { Store } from '../src/store.js';

export const FAKE = [process.execPath, fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))];

export const TOKEN = 't'.repeat(32);
export const AUTH = { authorization: `Bearer ${TOKEN}` };

export async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until: timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** True once the conversation has `n` turns and none is still running. */
export const turnsDone = (store: Store, convId: string, n: number) => {
  const t = store.listTurns(convId);
  return t.length === n && t.every((x) => x.status !== 'running');
};
