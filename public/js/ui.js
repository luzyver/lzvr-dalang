// Shared UI primitives: icons, dialogs, menus, segmented controls, switches, toasts and empty states.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { toasts, dismissToast } from './store.js';

/** A Lucide icon from /icons, drawn as a CSS mask so it takes the text colour. */
export function Icon({ name, class: cls, spin }) {
  return html`<span class=${cx('i', cls, spin && 'spin')} style=${{ '--m': `url(/icons/${name}.svg)` }} aria-hidden="true"></span>`;
}

/**
 * The Dalang mark: a gunungan (the leaf-shaped wayang figure that opens and closes a play) with the tree of life inside,
 * branching like the agents one dalang drives. Coloured by the theme, so it follows the accent palette.
 */
export const Logo = ({ size = 26 }) => html`<svg class="logo" width=${size} height=${size} viewBox="0 0 32 32" aria-hidden="true">
  <rect class="logo-tile" width="32" height="32" rx="7.5" />
  <g transform="translate(5.6 5.4) scale(.866)">
    <path class="logo-mark" d="M12 2.2C14.2 5.4 18.6 9 18.6 13.6C18.6 16.6 16 18.4 12 18.4C8 18.4 5.4 16.6 5.4 13.6C5.4 9 9.8 5.4 12 2.2Z" />
    <path class="logo-cut" d="M12 16.6V9M12 12.6 9.4 10.4M12 12.6l2.6-2.2" />
    <path class="logo-base" d="M8.5 21h7" />
  </g>
</svg>`;

export const Spinner = ({ class: cls }) => html`<${Icon} name="loader-circle" spin class=${cls} />`;

/**
 * A native modal <dialog>: focus trap, Esc and the backdrop come for free. `open` drives it; `onClose` runs when the
 * user closes it (Esc or a click on the backdrop). Children only render while open.
 */
export function Modal({ open, onClose, class: cls, label, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const d = ref.current;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return html`<dialog ref=${ref} class=${cx('modal', cls)} aria-label=${label}
    onClose=${() => open && onClose()} onCancel=${(e) => { e.preventDefault(); onClose(); }}
    onClick=${(e) => { if (e.target === ref.current) onClose(); }}>${open && children}</dialog>`;
}

const asking = signal(null);

/**
 * Asks the user to confirm an action in a modal, in place of window.confirm. Resolves true when they confirm, false
 * when they cancel or close it. `danger` styles the confirm button for actions that delete or throw work away.
 */
export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  asking.value?.resolve(false);
  return new Promise((resolve) => { asking.value = { title, message, confirmText, danger, resolve }; });
}

/** Renders the dialog `confirmDialog` asks; mounted once at the app root. */
export function ConfirmDialog() {
  const a = asking.value;
  const done = (ok) => { asking.value = null; a.resolve(ok); };
  return html`<${Modal} open=${!!a} label=${a?.title} class="dialog confirm" onClose=${() => done(false)}>
    ${a && html`<div class="dialog-body">
      <div class="dialog-head"><h2>${a.title}</h2></div>
      ${a.message && html`<p class="confirm-message">${a.message}</p>`}
      <div class="row end">
        <button class="btn" onClick=${() => done(false)}>Cancel</button>
        <button class=${cx('btn primary', a.danger && 'danger')} autofocus onClick=${() => done(true)}>${a.confirmText}</button>
      </div>
    </div>`}
  <//>`;
}

/**
 * A button that opens a small menu. The menu is fixed-positioned from the button's place on screen, so a scrolling
 * sidebar cannot clip it, and it opens upwards near the bottom of the screen.
 */
export function Menu({ icon = 'ellipsis', label, children, class: cls, buttonClass }) {
  const [pos, setPos] = useState(null);
  const wrap = useRef(null);
  useEffect(() => {
    if (!pos) return undefined;
    const close = () => setPos(null);
    const outside = (e) => { if (!wrap.current?.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    addEventListener('scroll', close, true);
    addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
      removeEventListener('scroll', close, true);
      removeEventListener('resize', close);
    };
  }, [pos]);
  const toggle = (e) => {
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const up = innerHeight - r.bottom < 240;
    setPos({ right: `${Math.max(8, innerWidth - r.right)}px`, ...(up ? { bottom: `${innerHeight - r.top + 4}px` } : { top: `${r.bottom + 4}px` }) });
  };
  return html`<div class=${cx('menu', cls)} ref=${wrap}>
    <button class=${cx('icon-btn', buttonClass)} aria-label=${label} title=${label} aria-haspopup="menu" aria-expanded=${!!pos} onClick=${toggle}><${Icon} name=${icon} /></button>
    ${pos && html`<div class="menu-pop" role="menu" style=${pos} onClick=${() => setPos(null)}>${children}</div>`}
  </div>`;
}

export const MenuItem = ({ icon, danger, onClick, title, children }) => html`
  <button role="menuitem" class=${cx('menu-item', danger && 'danger')} title=${title} onClick=${onClick}>
    ${icon && html`<${Icon} name=${icon} />`}<span>${children}</span>
  </button>`;

/** A segmented control: `options` is [value, label, icon?][]. */
export const Seg = ({ value, options, onChange, label, small }) => html`
  <div class=${cx('seg', small && 'sm')} role="radiogroup" aria-label=${label}>
    ${options.map(([v, text, icon]) => html`<button key=${v} role="radio" aria-checked=${v === value} class=${cx(v === value && 'active')} onClick=${() => onChange(v)}>
      ${icon && html`<${Icon} name=${icon} />`}${text}</button>`)}
  </div>`;

export const Switch = ({ checked, onChange, title, disabled }) => html`
  <label class="switch" title=${title}>
    <input type="checkbox" role="switch" checked=${checked} disabled=${disabled} aria-label=${title} onChange=${(e) => onChange(e.currentTarget.checked)} /><span></span>
  </label>`;

export const Empty = ({ icon, title, children }) => html`
  <div class="empty">
    ${icon && html`<div class="empty-icon"><${Icon} name=${icon} /></div>`}
    ${title && html`<strong>${title}</strong>`}
    ${children && html`<div class="empty-body">${children}</div>`}
  </div>`;

/** A labelled form field. */
export const Field = ({ label, hint, children }) => html`
  <label class="field"><span class="field-label">${label}</span>${children}${hint && html`<span class="field-hint">${hint}</span>`}</label>`;

/** A button that shows a spinner while its async `onClick` runs, and cannot be pressed twice meanwhile. */
export function AsyncButton({ onClick, class: cls, icon, busyText, title, disabled, children }) {
  const [busy, setBusy] = useState(false);
  const run = async (e) => {
    setBusy(true);
    try { await onClick(e); } finally { setBusy(false); }
  };
  return html`<button class=${cls} title=${title} disabled=${busy || disabled} onClick=${run}>
    ${busy ? html`<${Spinner} />` : icon && html`<${Icon} name=${icon} />`}${busy && busyText ? busyText : children}
  </button>`;
}

export function Toasts() {
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.value.map((t) => html`<div key=${t.id} class=${cx('toast', t.tone)}>
      <${Icon} name=${t.tone === 'err' ? 'circle-alert' : 'circle-check'} /><span>${t.text}</span>
      <button class="icon-btn sm" aria-label="Dismiss" onClick=${() => dismissToast(t.id)}><${Icon} name="x" /></button>
    </div>`)}
  </div>`;
}
