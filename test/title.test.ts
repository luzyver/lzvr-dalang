import { describe, expect, it } from 'vitest';
import { cleanTitle, Dispatcher } from '../src/dispatcher.js';
import { FAKE, turnsDone, until } from './helpers.js';
import { setupDispatcher } from './setup.js';

/** setupDispatcher, but with generated titles on. */
function titled(env: Record<string, string>) {
  const d = setupDispatcher(env);
  const dispatcher = new Dispatcher(d.store, { homes: d.dispatcher.accounts.homes, command: FAKE, env, autoTitle: true });
  return { ...d, dispatcher };
}

describe('chat titles', () => {
  it('uses the first prompt until a title is generated, then the title', async () => {
    const { store, dispatcher, conv } = titled({ FAKE_ANSWER: '"Fix the login redirect."' });
    store.enqueue(conv.id, 'the login page keeps sending me back to / after I sign in, can you look at it and fix it', []);
    dispatcher.kick(conv.id);
    await until(() => store.getConversation(conv.id)?.auto_title != null);
    expect(store.getConversation(conv.id)!.title).toBe('Fix the login redirect');
    expect(store.listConversations(conv.project_id)[0]!.title).toBe('Fix the login redirect');
    // the panel hears about it on the chat's event stream
    await until(() => store.eventsAfter(conv.id, 0).some((e) => e.type === 'conversation.title'));
  });

  it('titles a chat only once, from its first prompt', async () => {
    const { store, dispatcher, conv } = titled({ FAKE_ANSWER: 'First title' });
    store.enqueue(conv.id, 'one', []);
    dispatcher.kick(conv.id);
    await until(() => store.getConversation(conv.id)?.auto_title === 'First title');
    await until(() => turnsDone(store, conv.id, 1));
    store.enqueue(conv.id, 'two', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    await new Promise((r) => setTimeout(r, 300));
    expect(store.eventsAfter(conv.id, 0).filter((e) => e.type === 'conversation.title')).toHaveLength(1);
  });

  it('keeps the first prompt as the title when generation fails, and is off unless asked for', async () => {
    const failing = titled({ FAKE_MODE: 'fail' });
    failing.store.enqueue(failing.conv.id, 'do the thing', []);
    failing.dispatcher.kick(failing.conv.id);
    await until(() => turnsDone(failing.store, failing.conv.id, 1));
    await new Promise((r) => setTimeout(r, 300));
    expect(failing.store.getConversation(failing.conv.id)!.title).toBe('do the thing');

    const plain = setupDispatcher({ FAKE_ANSWER: 'Never used' });
    plain.store.enqueue(plain.conv.id, 'hello there', []);
    plain.dispatcher.kick(plain.conv.id);
    await until(() => turnsDone(plain.store, plain.conv.id, 1));
    expect(plain.store.getConversation(plain.conv.id)!.title).toBe('hello there');
  });

  it('cleans what agents wrap a title in', () => {
    expect(cleanTitle('## Title: "Add dark mode."\n\nextra')).toBe('Add dark mode');
    expect(cleanTitle('**Perbaiki bug login**')).toBe('Perbaiki bug login');
    expect(cleanTitle('x'.repeat(200))).toHaveLength(80);
  });
});
