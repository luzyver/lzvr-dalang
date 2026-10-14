// The search page: chats whose title, prompts or agent answers contain every word typed.
import { h, icon } from './dom.js';
import { api } from './api.js';

const KIND = { title: 'title', prompt: 'prompt', answer: 'answer' };

/** `text` with every occurrence of the search words wrapped in <mark>, built as DOM (never parsed as HTML). */
function highlight(text, terms) {
  const words = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return [text];
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? h('mark', {}, part) : part));
}

/** `open(convId, eventId)` shows the chat, scrolled to the matching message when there is one. */
export function searchPage({ query, guarded, open, close }) {
  const input = h('input', { type: 'search', value: query, placeholder: 'Search chats', 'aria-label': 'Search chats' });
  const results = h('div', { class: 'search-results' });

  const run = guarded(async () => {
    const q = input.value.trim();
    if (!q) { results.replaceChildren(); return; }
    results.replaceChildren(h('div', { class: 'small' }, 'Searching…'));
    const hits = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const terms = q.toLowerCase().split(/\s+/);
    results.replaceChildren(
      h('div', { class: 'small' }, hits.length ? `${hits.length}${hits.length >= 50 ? '+' : ''} match${hits.length === 1 ? '' : 'es'}` : 'Nothing found.'),
      ...hits.map((hit) => h('button', { class: 'search-hit', onclick: () => open(hit.conversation_id, hit.event_id) },
        h('span', { class: 'search-where small' }, `${hit.project} / `, h('strong', {}, hit.title || 'New chat'),
          h('span', { class: `search-kind ${hit.kind}` }, KIND[hit.kind] || hit.kind),
          hit.created_at && h('span', {}, ` · ${new Date(hit.created_at).toLocaleString()}`)),
        hit.kind !== 'title' && h('span', { class: 'search-text' }, highlight(hit.text, terms)))));
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  if (query) run();
  setTimeout(() => input.focus());
  return h('div', { class: 'page-body' },
    h('div', { class: 'row githead' }, h('strong', {}, 'Search'), h('span', { class: 'spacer' }),
      h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'small' }, 'Looks through chat titles, prompts and the agents\' answers in every project. Every word has to occur.'),
    h('div', { class: 'row' }, input, h('button', { class: 'primary', onclick: run }, 'Search')),
    results);
}
