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

// Links to tasks ("/tasks/<list>?task=<task>", relative or on this server), for task cards: [{ list, id }], at most three.
const TASK_RE = /(?:^|[\s(<"'])(?:https?:\/\/([^\s/<>"']+))?\/tasks\/([\w-]{6,})\?task=([\w-]{6,})/g;

export function taskLinksIn(text, host = typeof window !== 'undefined' ? window.location.host : '') {
  const out = [];
  for (const m of String(text || '').matchAll(TASK_RE)) {
    if (m[1] && m[1] !== host) continue;
    if (out.some((x) => x.id === m[3])) continue;
    out.push({ list: m[2], id: m[3] });
    if (out.length === 3) break;
  }
  return out;
}

/** The address of a task, to copy and paste in a message, an email or a document. */
export const taskLink = (t, origin = typeof window !== 'undefined' ? window.location.origin : '') => `${origin}/tasks/${t.list_id}?task=${t.id}`;

// Links to calendar events ("/calendar?event=<id>", with &at=<start> for one time of a repeating event),
// relative or on this server: [{ id, at }], each once, at most three.
const EVENT_RE = /(?:^|[\s(<"'])(?:https?:\/\/([^\s/<>"']+))?\/calendar\?event=([\w-]{6,})(?:&at=(\d{9,15}))?/g;

export function eventLinksIn(text, host = typeof window !== 'undefined' ? window.location.host : '') {
  const out = [];
  for (const m of String(text || '').matchAll(EVENT_RE)) {
    if (m[1] && m[1] !== host) continue;
    const at = m[3] ? Number(m[3]) : null;
    if (out.some((x) => x.id === m[2] && x.at === at)) continue;
    out.push({ id: m[2], at });
    if (out.length === 3) break;
  }
  return out;
}

/** The address of an event (for a repeating one, of this time of it). */
export const eventLink = (e, origin = typeof window !== 'undefined' ? window.location.origin : '') =>
  `${origin}/calendar?event=${e.id}${e.rrule ? `&at=${e.start}` : ''}`;

// Links to notes ("/notes?note=<id>", relative or on this server): [{ id }], each once, at most three.
const NOTE_RE = /(?:^|[\s(<"'])(?:https?:\/\/([^\s/<>"']+))?\/notes\?note=([\w-]{6,})/g;

export function noteLinksIn(text, host = typeof window !== 'undefined' ? window.location.host : '') {
  const out = [];
  for (const m of String(text || '').matchAll(NOTE_RE)) {
    if (m[1] && m[1] !== host) continue;
    if (out.some((x) => x.id === m[2])) continue;
    out.push({ id: m[2] });
    if (out.length === 3) break;
  }
  return out;
}

/** The address of a note. */
export const noteLink = (n, origin = typeof window !== 'undefined' ? window.location.origin : '') => `${origin}/notes?note=${n.id}`;

// Links to forms ("/f/<token>", relative or on this server): [{ token }], each once, at most three.
const FORM_RE = /(?:^|[\s(<"'])(?:https?:\/\/([^\s/<>"']+))?\/f\/([\w-]{8,})(?![\w/-])/g;

export function formLinksIn(text, host = typeof window !== 'undefined' ? window.location.host : '') {
  const out = [];
  for (const m of String(text || '').matchAll(FORM_RE)) {
    if (m[1] && m[1] !== host) continue;
    if (out.some((x) => x.token === m[2])) continue;
    out.push({ token: m[2] });
    if (out.length === 3) break;
  }
  return out;
}
