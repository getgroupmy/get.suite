// "Email people with access" (in Docs, Sheets and Slides): a new email in Mail to everyone the file is shared with
// (by name: people, groups, its folders' shares), with its name as the subject and a link to it, ready to write and send.
import { get } from '../api.js';
import { DRAFT_KEY } from './docs/blocks.js';
import { formatAddress } from '../components/addresses.js';

const APP = { doc: 'docs', sheet: 'sheets', slides: 'slides' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The message for these people about this file: { to, subject, html }. */
export function messageAbout(file, people, origin) {
  const url = `${origin}/${APP[file.kind] || 'drive'}/${file.id}`;
  return { to: people.map((p) => formatAddress({ name: p.name, email: p.username })).join(', '), subject: file.name, html: `<p><a href="${esc(url)}">${esc(file.name)}</a></p><p></p>` };
}

export async function emailPeopleWithAccess(file, { navigate, toast }) {
  let r;
  try { r = await get(`/files/${file.id}/people`); } catch (e) { toast(e.message, 'error'); return; }
  if (!r.people.length) {
    toast(r.everyone_at_company ? 'It’s shared with everyone at the company, and nobody by name: write to them from Mail' : 'Nobody else has access yet: share it first', 'info');
    return;
  }
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(messageAbout(file, r.people, window.location.origin))); } catch { toast('Your browser’s storage is off, so the email can’t be started from here', 'error'); return; }
  navigate('/mail?compose_doc=1');
}
