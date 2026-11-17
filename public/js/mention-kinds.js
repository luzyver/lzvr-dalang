// The lists behind the composer's @ menu, kept apart from the Preact hook so they can be tested.

// "@db", "@database", "@ssh" or "@template" right before the caret, with what follows it so far ("@db:pro").
export const MENTION = /(^|\s)@(database|db|ssh|template):?([\w.-]*)$/i;

export const MENTION_KINDS = {
  db: { url: '/api/db/agent-connections', icon: 'database', label: 'Databases', none: 'No database connection agents may use' },
  ssh: { url: '/api/ssh/agent-hosts', icon: 'terminal', label: 'SSH hosts', none: 'No SSH host agents may use' },
  template: { url: '/api/templates', icon: 'file', label: 'PDF templates', none: 'No template yet: an admin adds them in Settings' },
  skill: { url: '/api/custom-skills', icon: 'sparkles', label: 'Custom skills', none: 'No custom skill yet: an admin adds them in Settings' },
};

/** Which list a typed "@word" (or the "/custom" command, `skill`) opens. */
export const mentionKind = (word, skill) => (skill ? 'skill' : word === 'ssh' ? 'ssh' : word === 'template' ? 'template' : 'db');

/** Lists that change in Settings are read again each time they open; connections and hosts once. */
export const refreshes = (kind) => kind === 'skill' || kind === 'template';

/** Menu items from an API answer: skills and templates come as {name, description}, connections and hosts as items already. */
export const menuItems = (kind, list) => (refreshes(kind) ? list.map((x) => ({ id: x.name, label: x.name, note: x.description })) : list);

/** What picking `id` writes into the box. */
export const mentionText = (kind, id) => (kind === 'skill' ? `/custom ${id} ` : `@${kind}:${id} `);
