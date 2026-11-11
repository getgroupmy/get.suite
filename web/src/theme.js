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

/** A company's own colour in place of the usual blue (null: the usual one). */
export function applyAccent(color) {
  const s = document.documentElement.style;
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) { for (const v of ['--accent', '--accent-text', '--accent-soft', '--on-accent']) s.removeProperty(v); return; }
  s.setProperty('--accent', color);
  s.setProperty('--on-accent', onAccent(color));
  s.setProperty('--accent-text', `color-mix(in srgb, ${color} 80%, var(--text))`);
  s.setProperty('--accent-soft', `color-mix(in srgb, ${color} 20%, var(--surface))`);
}

/** Text that reads on a colour: white when it has 4.5:1 contrast there (WCAG AA), otherwise near-black. */
export function onAccent(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (lum + 0.05) >= 4.5 ? '#fff' : '#1f1f1f';
}
