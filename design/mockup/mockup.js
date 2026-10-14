// Mockup interactions only: theme, palette, sidebar/inspector, tabs, command palette and settings.
const root = document.documentElement;
const app = document.getElementById('app');
const palette = document.getElementById('palette');
const settings = document.getElementById('settings');
const dark = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const t = root.dataset.theme;
  root.dataset.mode = t === 'system' ? (dark.matches ? 'dark' : 'light') : t;
  document.querySelectorAll('[data-control=theme] button').forEach((b) => b.classList.toggle('active', b.dataset.v === t));
  document.querySelectorAll('[data-control=palette] button').forEach((b) => b.classList.toggle('active', b.dataset.v === root.dataset.palette));
  localStorage.setItem('dalang-mock', JSON.stringify({ theme: t, palette: root.dataset.palette }));
}
try { Object.assign(root.dataset, JSON.parse(localStorage.getItem('dalang-mock')) || {}); } catch { /* first visit */ }
for (const [k, v] of new URLSearchParams(location.search)) if (k === 'theme' || k === 'palette') root.dataset[k] = v;
dark.addEventListener('change', applyTheme);
applyTheme();

if (innerWidth <= 1280) app.classList.add('no-insp');
requestAnimationFrame(() => requestAnimationFrame(() => app.classList.remove('preload')));

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
}

document.addEventListener('click', (e) => {
  const control = e.target.closest('[data-control] button');
  if (control) { root.dataset[control.parentElement.dataset.control] = control.dataset.v; applyTheme(); return; }
  const tab = e.target.closest('.tab');
  if (tab) { showTab(tab.dataset.tab); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'toggle-sidebar': app.classList.toggle(innerWidth <= 900 ? 'side-open' : 'no-side'); break;
    case 'inspector':
      if (el.dataset.tab) { showTab(el.dataset.tab); app.classList.remove('no-insp'); } else app.classList.toggle('no-insp');
      break;
    case 'close-overlays': app.classList.add('no-insp'); app.classList.remove('side-open'); break;
    case 'palette': palette.showModal(); palette.querySelector('input').select(); break;
    case 'settings': settings.showModal(); break;
    case 'close-settings': settings.close(); break;
  }
});

// a click on the backdrop closes a dialog
for (const d of [palette, settings]) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.open ? palette.close() : (palette.showModal(), palette.querySelector('input').select()); }
  if (palette.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const items = [...palette.querySelectorAll('.palette-item')];
    const i = items.findIndex((x) => x.classList.contains('active'));
    items[i]?.classList.remove('active');
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].classList.add('active');
  }
});
