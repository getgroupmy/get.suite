// Links to Workspace files in a message ("/docs/abc", "https://this-server/sheets/xyz", a folder's
// "/drive/folder/…"), for showing them as cards: [{ id, kind }], each file once, at most three.
const RE = /(?:^|[\s(<"'])(?:https?:\/\/([^\s/<>"']+))?\/(docs|sheets|slides|drive\/folder)\/([\w-]{6,})/g;
const KIND = { docs: 'doc', sheets: 'sheet', slides: 'slides', 'drive/folder': 'folder' };

export function fileLinksIn(text, host = typeof window !== 'undefined' ? window.location.host : '') {
  const out = [];
  for (const m of String(text || '').matchAll(RE)) {
    if (m[1] && m[1] !== host) continue; // another server's link is just a link
    if (out.some((x) => x.id === m[3])) continue;
    out.push({ id: m[3], kind: KIND[m[2]] });
    if (out.length === 3) break;
  }
  return out;
}
