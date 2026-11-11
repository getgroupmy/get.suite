// Inbox tabs: Primary for mail from people, Updates for mail sent by machines to many (newsletters,
// notifications, receipts, mailing lists), told apart by the headers such mail carries. A message
// can be moved to the other tab by hand, kept as an IMAP keyword on it (so it stays where you put it,
// on every device that reads these keywords).
import { allOf } from './searchquery.js';

export const TO_PRIMARY = '$NwPrimary';
export const TO_UPDATES = '$NwUpdates';
export const TABS = ['primary', 'updates'];

/**
 * Mail sent in bulk or by a machine: a mailing list, an unsubscribe link, bulk precedence, or an automatic message.
 * An automatic *reply* to you (an out-of-office answer: Auto-Submitted: auto-replied) is a person's, so bulk
 * precedence, which vacation replies carry, doesn't make it an update.
 */
const NOT_AUTO_REPLY = { not: { header: { 'auto-submitted': 'auto-replied' } } };
const BULK = { or: [
  { header: { 'list-id': true } },
  { header: { 'list-unsubscribe': true } },
  allOf([{ header: { precedence: 'bulk' } }, NOT_AUTO_REPLY]),
  allOf([{ header: { precedence: 'list' } }, NOT_AUTO_REPLY]),
  { header: { 'auto-submitted': 'auto-generated' } },
] };

/** The IMAP search for a tab of the Inbox. */
export function tabQuery(tab) {
  const updates = { or: [allOf([BULK, { unKeyword: TO_PRIMARY }]), { keyword: TO_UPDATES }] };
  return tab === 'updates' ? updates : { not: updates };
}

/** Which tab a message's headers (a Map or object of lower-case names) and flags put it in. */
export function tabOf(headers, flags = []) {
  const has = (k) => (headers instanceof Map ? headers.has(k) : k in (headers || {}));
  const get = (k) => String((headers instanceof Map ? headers.get(k) : headers?.[k]) ?? '').toLowerCase();
  const f = new Set([...flags].map((x) => String(x).toLowerCase()));
  if (f.has(TO_UPDATES.toLowerCase())) return 'updates';
  if (f.has(TO_PRIMARY.toLowerCase())) return 'primary';
  const autoReply = get('auto-submitted').startsWith('auto-replied');
  const bulk = has('list-id') || has('list-unsubscribe') || (/^(bulk|list)$/.test(get('precedence').trim()) && !autoReply) || get('auto-submitted').startsWith('auto-generated');
  return bulk ? 'updates' : 'primary';
}
