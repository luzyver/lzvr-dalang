// Which chat runs under which, across projects: a sub-agent may be started in another project than the chat that
// started it. The sidebar, the status lists and the Agents tab all read this one index.
import { computed } from '../vendor/signals.js';
import { convs, projects } from './store.js';

/** Every chat the panel has, by id with its project, and each chat's own sub-chats. */
export const family = computed(() => {
  const byId = new Map();
  for (const project of projects.value) for (const conv of convs.value.get(project.id) || []) byId.set(conv.id, { project, conv });
  const kids = new Map();
  for (const { conv } of byId.values()) {
    if (conv.parent && byId.has(conv.parent)) kids.set(conv.parent, [...(kids.get(conv.parent) || []), conv]);
  }
  return { byId, kids };
});

/** Whether a chat is listed in the sidebar: not started under another chat the panel has (its parent may be gone or hidden). */
export const isTop = (c) => !c.parent || !family.value.byId.has(c.parent);

/** The chat a person started that `id` runs under (itself when it is one), with its project. */
export function rootOf(id) {
  const { byId } = family.value;
  let found = byId.get(id);
  for (let n = 0; found && !isTop(found.conv) && n < 100; n++) found = byId.get(found.conv.parent);
  return found || null;
}

/** Every chat under `id`, at any depth and in any project. */
export function descendants(id) {
  const { kids } = family.value;
  const out = [];
  const seen = new Set([id]);
  const walk = (p) => { for (const c of kids.get(p) || []) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); walk(c.id); } };
  walk(id);
  return out;
}
