// Syntax highlighting with highlight.js, loaded on first use so the panel starts without it. Its output is the one
// place the panel inserts HTML: highlight.js escapes the code and only adds <span class="hljs-…"> around it.
import { signal } from '../vendor/signals.js';

const LANGS = ['bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'dockerfile', 'go', 'ini', 'java', 'javascript', 'json', 'kotlin',
  'makefile', 'markdown', 'php', 'python', 'ruby', 'rust', 'scss', 'shell', 'sql', 'swift', 'typescript', 'xml', 'yaml'];

const EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  cts: 'typescript', json: 'json', jsonc: 'json', sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', go: 'go', rs: 'rust',
  css: 'css', scss: 'scss', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', yml: 'yaml', yaml: 'yaml', sql: 'sql',
  md: 'markdown', java: 'java', kt: 'kotlin', php: 'php', rb: 'ruby', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
  hpp: 'cpp', cs: 'csharp', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', diff: 'diff', patch: 'diff',
};
const NAMES = { dockerfile: 'dockerfile', makefile: 'makefile', '.env': 'bash' };

/** The language for a file path, or '' when highlighting it would not help. */
export function languageFor(path) {
  const name = String(path || '').split(/[\/]/).pop().toLowerCase();
  if (NAMES[name]) return NAMES[name];
  return EXT[name.includes('.') ? name.split('.').pop() : ''] || '';
}

const ready = signal(false);
let hljs = null;
let loading = null;
function load() {
  loading ||= Promise.all([import('../vendor/hljs.js'), ...LANGS.map((l) => import(`../vendor/hljs-${l}.js`))])
    .then(([core, ...langs]) => {
      hljs = core.default;
      langs.forEach((m, i) => hljs.registerLanguage(LANGS[i], m.default));
      ready.value = true;
    })
    .catch(() => { /* stays plain text */ });
  return loading;
}

const cache = new Map();
/**
 * Highlighted HTML for `code`, or null while highlight.js loads (the caller shows plain text; reading `ready` here
 * re-renders it once loaded), for an unknown language, or for very long input.
 */
export function highlight(code, lang) {
  if (!lang || code.length > 20000) return null;
  if (!ready.value) { load(); return null; }
  if (!hljs.getLanguage(lang)) return null;
  const key = `${lang}\n${code}`;
  let out = cache.get(key);
  if (out === undefined) {
    try { out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { out = null; }
    if (cache.size > 4000) cache.clear();
    cache.set(key, out);
  }
  return out;
}
