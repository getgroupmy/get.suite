// Dropdown chips in documents (web/src/apps/docs/dropchip.js), as plain text for downloads and search.
/** A dropdown chip's text: its choice, or its first choice before one is picked. */
export const chipText = (a) => (Array.isArray(a?.options) && (a.options.find((o) => o?.label === a.value)?.label || a.options[0]?.label)) || '—';
