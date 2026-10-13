import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/dispatcher.js';
import { Store } from '../src/store.js';
import { FAKE } from './helpers.js';

export function setupDispatcher(env: Record<string, string> = {}, command: string[] = FAKE, homeNames: string[] = ['a']) {
  const dir = mkdtempSync(join(tmpdir(), 'lzvr-disp-'));
  const homes = homeNames.map((n) => join(dir, n));
  const store = new Store();
  const dispatcher = new Dispatcher(store, { homes, command, env });
  const project = store.createProject('p', dir);
  const conv = store.createConversation(project.id);
  return { dir, store, dispatcher, project, conv };
}
