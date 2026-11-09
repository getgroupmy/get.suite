// Contact photos: one small picture per contact (JPEG, PNG, WebP or GIF, at most 300 KB), kept apart
// from the contact's row so lists stay light. Phones' photos come and go with their cards (CardDAV,
// .vcf files) as vCard PHOTO lines.
import { q } from './db.js';

q(`CREATE TABLE IF NOT EXISTS contact_photos (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  data BLOB NOT NULL,
  mime TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`).run();

export const MAX_PHOTO = 300 * 1024;

/** What kind of picture the bytes are (by their first bytes), or null. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (/^GIF8[79]a/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

export const photoOf = (contactId) => q('SELECT data, mime, updated_at FROM contact_photos WHERE contact_id = ?').get(contactId) || null;

/** Keep a photo for a contact (null or empty takes it away). Refuses anything that isn't a small picture. */
export function setPhoto(contactId, buf) {
  if (!buf || !buf.length) { q('DELETE FROM contact_photos WHERE contact_id = ?').run(contactId); return null; }
  const mime = sniffImage(buf);
  if (!mime) throw Object.assign(new Error('A photo must be a JPEG, PNG, WebP or GIF picture'), { status: 400 });
  if (buf.length > MAX_PHOTO) throw Object.assign(new Error('That photo is too big (300 KB at most)'), { status: 400 });
  const at = Date.now();
  q(`INSERT INTO contact_photos (contact_id, data, mime, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET data = excluded.data, mime = excluded.mime, updated_at = excluded.updated_at`).run(contactId, buf, mime, at);
  return at;
}

/** The contact with its photo attached, for writing its vCard. */
export function withPhoto(c) {
  const p = c && photoOf(c.id);
  return p ? { ...c, photo: Buffer.from(p.data), photo_type: p.mime } : c;
}

/** From a phone's card or a file: keep the photo when it's a usable picture, else leave things be. */
export function photoFromCard(contactId, card) {
  try { if (card.photo) setPhoto(contactId, card.photo); else setPhoto(contactId, null); } catch { /* not a picture we keep */ }
}
