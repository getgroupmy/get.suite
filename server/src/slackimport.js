// A Slack workspace export (Workspace settings → Import/export data → Export, a .zip): users.json, channels.json,
// and a folder per public channel with a .json file per day of messages. This reads it into plain data:
// { users: Map(slackId → { name, email }), channels: [{ name, topic, archived, messages: [{ ts, user, name, text, thread_ts }] }] }.

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Slack's markup as plain text: <@U123> → @Name, <#C1|general> → #general, <https://x|label> → label (https://x). */
export function slackText(text, users = new Map()) {
  return decode(String(text || '').replace(/<([^<>]+)>/g, (m, inner) => {
    const [target, label] = inner.split('|');
    if (target.startsWith('@')) return `@${users.get(target.slice(1))?.name || label || target.slice(1)}`;
    if (target.startsWith('#')) return `#${label || target.slice(1)}`;
    if (target.startsWith('!')) return `@${label || target.slice(1).replace(/^subteam\^\w+/, 'group')}`; // @here, @channel
    return label && label !== target ? `${label} (${target})` : target;
  }));
}

// Messages that are Slack's own notes about the channel, not anything someone wrote.
const SKIP = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive', 'bot_add', 'bot_remove', 'pinned_item', 'unpinned_item']);

/** The export's files (path → text) read into users and channels; { error } when it isn't a Slack export. */
export function readSlackExport(files) {
  const json = (p) => { try { return JSON.parse(files.get(p)); } catch { return null; } };
  const channelsJson = json('channels.json');
  if (!Array.isArray(channelsJson)) return { error: 'That isn’t a Slack export (a .zip with channels.json in it)' };
  const users = new Map();
  for (const u of json('users.json') || []) {
    if (!u?.id) continue;
    users.set(u.id, { name: u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || u.id, email: String(u.profile?.email || '').toLowerCase() || null });
  }
  const channels = channelsJson.filter((c) => c?.name).map((c) => {
    const days = [...files.keys()].filter((p) => p.startsWith(`${c.name}/`) && p.endsWith('.json')).sort();
    const messages = [];
    for (const d of days) {
      for (const m of json(d) || []) {
        if (!m || m.type !== 'message' || SKIP.has(m.subtype) || !m.ts) continue;
        const text = slackText(m.text, users) + (Array.isArray(m.files) && m.files.length ? `${m.text ? '\n' : ''}${m.files.map((f) => `📎 ${f.name || f.title || 'a file'}`).join('\n')}` : '');
        if (!text.trim()) continue;
        messages.push({ ts: String(m.ts), user: m.user || null, name: m.user_profile?.real_name || users.get(m.user)?.name || m.username || 'Slack', text, thread_ts: m.thread_ts && m.thread_ts !== m.ts ? String(m.thread_ts) : null });
      }
    }
    messages.sort((a, b) => Number(a.ts) - Number(b.ts));
    return { name: String(c.name).slice(0, 80), topic: c.topic?.value || c.purpose?.value || null, archived: !!c.is_archived, messages };
  });
  return { users, channels };
}
