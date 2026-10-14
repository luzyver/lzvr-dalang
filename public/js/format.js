// Small formatting helpers for times, durations and token counts.

/** A Date from epoch ms, an ISO string or SQLite's `YYYY-MM-DD HH:MM:SS` (UTC); null when it is none of those. */
export function toDate(value) {
  if (value == null || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

export const clock = (value) => {
  const d = toDate(value);
  return d ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(d) : '';
};

export const dateTime = (value) => {
  const d = toDate(value);
  return d ? d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
};

/** 8.2s, 1m 42s, 2h 3m, 3d 4h */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ${m % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

/** Time until an epoch-seconds or ms moment, e.g. "in 3h 12m". */
export const until = (ms) => (ms ? duration(Math.max(0, ms - Date.now())).replace(/\.\ds$/, 's') : '');

export const tokens = (n) => (n == null ? '?' : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
