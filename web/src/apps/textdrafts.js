// Unsaved edits of a text file kept in this browser as they're typed (so a crash, a closed laptop or a killed tab
// doesn't lose them): { text, version (the file's, when editing began), at }. Cleared on Save, Cancel or Discard.
const key = (fileId) => `nw.textDraft.${fileId}`;

export function readDraft(fileId) {
  if (!fileId) return null;
  try { const v = JSON.parse(localStorage.getItem(key(fileId)) || 'null'); return v && typeof v.text === 'string' ? v : null; } catch { return null; }
}
export function keepDraft(fileId, text, version) {
  if (!fileId) return;
  try { localStorage.setItem(key(fileId), JSON.stringify({ text, version, at: Date.now() })); } catch { /* full or private: not kept */ }
}
export function dropDraft(fileId) {
  if (!fileId) return;
  try { localStorage.removeItem(key(fileId)); } catch { /* private window */ }
}
