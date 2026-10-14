// The panel's view layer: Preact components written with htm tagged templates (no build step, no JSX).
// htm builds vnodes, never HTML strings, so every server-provided string still ends up as text.
import { h } from '../vendor/preact.js';
import htm from '../vendor/htm.js';

export const html = htm.bind(h);

/** Join class names, skipping falsy ones: cx('btn', primary && 'primary'). */
export const cx = (...names) => names.filter(Boolean).join(' ');
