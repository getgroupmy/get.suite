// Who in your company has a profile photo (loaded once, kept up to date live), for Avatar.
import { useEffect, useState } from 'react';
import { get, onLive } from '../api.js';

let byId = new Map(), byEmail = new Map(), loading = null;
const listeners = new Set();
function load() {
  loading = get('/users/photos').then((list) => {
    byId = new Map(list.map((p) => [p.id, `/api/users/${p.id}/photo?v=${p.v}`]));
    byEmail = new Map(list.map((p) => [p.email.toLowerCase(), `/api/users/${p.id}/photo?v=${p.v}`]));
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
