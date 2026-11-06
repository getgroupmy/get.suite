// Light, dark, or following the system: chosen in Settings, kept on this device.
const KEY = 'nw.theme';

export function getTheme() {
  try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
}

export function setTheme(t) {
  const el = document.documentElement;
  if (t === 'light' || t === 'dark') el.dataset.theme = t; else delete el.dataset.theme;
  try { if (t === 'light' || t === 'dark') localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* storage blocked: for this visit only */ }
  window.dispatchEvent(new CustomEvent('nw:theme', { detail: t }));
}

/** Is the page dark right now (chosen, or the system's)? */
export function isDark() {
  const t = getTheme();
  return t === 'dark' || (t === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}
