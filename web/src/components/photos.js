// Who in your company has a profile photo (loaded once, kept up to date live), for Avatar.
import { useEffect, useState } from 'react';
import { get, onLive } from '../api.js';

let byId = new Map(), byEmail = new Map(), loading = null, off = false;
/** For a page seen without an account (a guest in a meeting): there are no photos to load. */
export const noPhotos = () => { off = true; };
const listeners = new Set();
function load() {
  if (off) return Promise.resolve();
  // Colleagues' own photos first; then photos on your contacts (and the company's), for everyone else.
  loading = Promise.all([get('/users/photos'), get('/contacts/photos').catch(() => [])]).then(([list, contacts]) => {
    byId = new Map(list.map((p) => [p.id, `/api/users/${p.id}/photo?v=${p.v}`]));
    byEmail = new Map(contacts.map((c) => [c.email, c.url]).reverse()); // your own contact wins over a shared one
    for (const p of list) byEmail.set(p.email.toLowerCase(), `/api/users/${p.id}/photo?v=${p.v}`);
    for (const f of listeners) f();
  }).catch(() => {});
  return loading;
}
let live = false;
/** The photo address for a person (by account id or email address), or null. */
export function usePhoto(userId, email) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const f = () => redraw((n) => n + 1);
    listeners.add(f);
    if (!loading) load();
    if (!live) { live = true; onLive((m) => { if (m.type === 'photos-changed' || m.type === 'live-connected') load(); }); }
    return () => listeners.delete(f);
  }, []);
  return (userId && byId.get(userId)) || (email && byEmail.get(String(email).toLowerCase())) || null;
}
/** After changing your own photo: everyone's list again. */
export const reloadPhotos = () => load();
