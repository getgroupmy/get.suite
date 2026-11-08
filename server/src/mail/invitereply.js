// Guests' emailed answers to your invitations (from Outlook, Gmail, a phone...): put on the event,
// with a bell notification and the calendar refreshed, once per change. Used when the message is
// opened in Mail, and by the new-mail watcher as answers arrive.
import { applyReply } from './invite.js';
import { MAIL_HOSTNAME } from './config.js';
import { notify as bell } from '../notifications.js';
import { touch } from '../routes/calendar.js';

const WORD = { yes: 'accepted', maybe: 'tentatively accepted', no: 'declined' };

export function recordReply(ownerId, reply) {
  const r = applyReply(ownerId, reply, MAIL_HOSTNAME || 'workspace');
  if (!r) return null;
  if (r.changed) {
    bell([ownerId], { kind: 'invite', title: `${r.who} ${WORD[r.answer]} “${r.title}”`, body: 'Answered by email', link: '/calendar', actor: null });
    touch([ownerId]);
  }
  return r;
}
