// Theme (light / dark / system) and accent palette, kept in localStorage and applied as data attributes on <html>.
import { effect, signal } from '../vendor/signals.js';

export const THEMES = [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']];
export const PALETTES = [
  ['iris', 'Iris × Slate', 'Cool and calm; the accent never reads as a status colour'],
  ['jade', 'Jade × Sage', 'Close to the original teal'],
  ['amber', 'Blencong × Sand', 'The warm oil lamp a dalang plays under'],
];

const saved = (k, v) => { try { return localStorage.getItem(k) || v; } catch { return v; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: lasts until reload */ } };

export const theme = signal(saved('dalang-theme', 'system'));
export const palette = signal(saved('dalang-palette', 'iris'));

const dark = matchMedia('(prefers-color-scheme: dark)');
const systemDark = signal(dark.matches);
dark.addEventListener('change', () => { systemDark.value = dark.matches; });

effect(() => {
  const d = document.documentElement;
  const mode = theme.value === 'system' ? (systemDark.value ? 'dark' : 'light') : theme.value;
  d.dataset.theme = theme.value;
  d.dataset.palette = palette.value;
  d.dataset.mode = mode;
  save('dalang-theme', theme.value);
  save('dalang-palette', palette.value);
  // The browser chrome (and the installed app's title bar) follows the panel's background.
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = getComputedStyle(d).getPropertyValue('--bg-side').trim() || meta.content;
});
