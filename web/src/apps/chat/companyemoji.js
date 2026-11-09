// Company emoji (Chat): the company's own small pictures, written :name: in messages and used as
// reactions. One list for the whole app, loaded once and again when anyone adds or removes one.
import { useEffect, useState } from 'react';
import { get, onLive } from '../../api.js';

export const imageUrl = (name) => `/api/chat/emoji/${encodeURIComponent(name)}/image`;
/** ":ship-it:" → "ship-it", or null when it isn't written as a company emoji. */
export const customName = (s) => /^:([a-z0-9_-]{2,32}):$/.exec(String(s || ''))?.[1] || null;

/** Text cut into plain pieces and company emoji it names that exist: ['Released ', { emoji: 'ship-it' }, '!']. */
export function splitEmoji(text, known) {
  const out = [];
  const re = /:([a-z0-9_-]{2,32}):/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!known.has(m[1])) { re.lastIndex = m.index + 1; continue; } // ":30:" in "10:30:45" isn't one
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ emoji: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

let list = null; // [{ name, created_by, created_by_name }]
let loading = null;
const subscribers = new Set();
const tell = () => subscribers.forEach((f) => f(list));
export function reloadEmoji() {
  loading = get('/chat/emoji').then((l) => { list = l; tell(); }).catch(() => { list = list || []; tell(); }).finally(() => { loading = null; });
  return loading;
}
let watching = false;

/** The company's emoji ([] until loaded), kept up to date. */
export function useCompanyEmoji() {
  const [now, setNow] = useState(list || []);
  useEffect(() => {
    subscribers.add(setNow);
    if (!list && !loading) reloadEmoji();
    if (!watching) { watching = true; onLive((m) => { if (m.type === 'chat-emoji-changed') reloadEmoji(); }); }
    return () => { subscribers.delete(setNow); };
  }, []);
  return now;
}
