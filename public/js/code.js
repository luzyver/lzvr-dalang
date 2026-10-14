// A highlighted code block with its language and a copy button.
import { html } from './lib.js';
import { Icon } from './ui.js';
import { highlight } from './highlight.js';
import { toast } from './store.js';

export async function copyText(text, what = 'copied') {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('copy failed: the browser refused the clipboard', 'err'); }
}

const ALIAS = { js: 'javascript', ts: 'typescript', sh: 'bash', zsh: 'bash', console: 'bash', py: 'python', rs: 'rust',
  yml: 'yaml', html: 'xml', toml: 'ini', md: 'markdown', 'c++': 'cpp', 'c#': 'csharp', golang: 'go', jsonc: 'json', tsx: 'typescript', jsx: 'javascript' };

export function CodeBlock({ code, lang }) {
  const language = ALIAS[lang] || lang;
  const hl = highlight(code, language);
  return html`<div class="code">
    <div class="code-head"><span>${lang || 'text'}</span>
      <button class="icon-btn sm" aria-label="Copy code" title="Copy" onClick=${() => copyText(code)}><${Icon} name="copy" /></button></div>
    ${hl == null ? html`<pre><code>${code}</code></pre>` : html`<pre><code class="hljs" dangerouslySetInnerHTML=${{ __html: hl }}></code></pre>`}
  </div>`;
}
