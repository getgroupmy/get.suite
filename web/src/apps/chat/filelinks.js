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

// Links to chat messages ("/chat/<conversation>?msg=<message>", relative or on this server), for
// quoted cards: [{ channel, id, thread }], each message once, at most three.
const MSG_RE = /(?:^|[\s(<"'])(?:https?:\/\/([^\s/<>"']+))?\/chat\/([\w-]{6,})\?((?:[\w-]+=[\w-]*&?)+)/g;

export function messageLinksIn(text, host = typeof window !== 'undefined' ? window.location.host : '') {
  const out = [];
  for (const m of String(text || '').matchAll(MSG_RE)) {
    if (m[1] && m[1] !== host) continue;
    const params = new URLSearchParams(m[3]);
    const id = params.get('msg');
    if (!id || !/^[\w-]{6,}$/.test(id) || out.some((x) => x.id === id)) continue;
    const thread = params.get('thread');
    out.push({ channel: m[2], id, thread: thread && /^[\w-]{6,}$/.test(thread) ? thread : null });
    if (out.length === 3) break;
  }
  return out;
}

/** The address of a message, to copy and paste somewhere else (a reply in a thread opens the thread). */
export const messageLink = (m, origin = typeof window !== 'undefined' ? window.location.origin : '') =>
  `${origin}/chat/${m.channel_id}?msg=${m.id}${m.parent_id ? `&thread=${m.parent_id}` : ''}`;
