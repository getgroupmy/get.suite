// When a file attached in Chat goes to the trash (or comes back), the conversations it was sent in are
// told at once, so an open conversation shows it as "no longer available" (or available again).
import { q } from './db.js';
import { sendTo } from './hub.js';
import { orgMemberIds } from './tenancy.js';

export function announceFileState(fileId) {
  const id = String(fileId);
  const f = q('SELECT kind, trashed FROM files WHERE id = ?').get(id);
  if (f && f.kind !== 'file') return;
  const gone = !f || !!f.trashed;
  const rows = q('SELECT id, channel_id FROM messages WHERE instr(files, ?) > 0 AND deleted_at IS NULL').all(`"${id}"`);
  const byChannel = new Map();
  for (const m of rows) byChannel.set(m.channel_id, [...(byChannel.get(m.channel_id) || []), m.id]);
  for (const [channelId, messageIds] of byChannel) {
    const c = q('SELECT id, org_id, dm_key, private FROM channels WHERE id = ?').get(channelId);
    if (!c) continue;
    const people = c.dm_key || c.private ? q('SELECT user_id FROM channel_members WHERE channel_id = ?').all(c.id).map((r) => r.user_id) : orgMemberIds(c.org_id);
    sendTo(people, { type: 'chat-file-state', channel_id: c.id, message_ids: messageIds, file_id: id, gone });
  }
}
