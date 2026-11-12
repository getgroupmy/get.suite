// A Slack workspace export (Workspace settings → Import/export data → Export, a .zip): users.json, channels.json,
// and a folder per public channel with a .json file per day of messages. This reads it into plain data:
// { users: Map(slackId → { name, email }), channels: [{ name, topic, archived, messages: [{ ts, user, name, text, thread_ts }] }] }.

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Slack's names for the emoji people react with most (custom emoji can't come over: they're the workspace's own pictures).
const SLACK_EMOJI = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', heart: '❤️', joy: '😂', laughing: '😆', smile: '😄', grin: '😁', smiley: '😃',
  slightly_smiling_face: '🙂', wink: '😉', blush: '😊', heart_eyes: '😍', sweat_smile: '😅', rolling_on_the_floor_laughing: '🤣', thinking_face: '🤔',
  eyes: '👀', tada: '🎉', partying_face: '🥳', clap: '👏', raised_hands: '🙌', pray: '🙏', ok_hand: '👌', wave: '👋', muscle: '💪', point_up: '☝️',
  fire: '🔥', rocket: '🚀', '100': '💯', star: '⭐', star2: '🌟', sparkles: '✨', white_check_mark: '✅', heavy_check_mark: '✔️', ballot_box_with_check: '☑️',
  x: '❌', warning: '⚠️', exclamation: '❗', question: '❓', bulb: '💡', memo: '📝', pushpin: '📌', calendar: '📅', coffee: '☕', beers: '🍻', cake: '🍰',
  sob: '😭', cry: '😢', disappointed: '😞', confused: '😕', scream: '😱', open_mouth: '😮', astonished: '😲', rage: '😡', angry: '😠', sunglasses: '😎',
  upside_down_face: '🙃', face_palm: '🤦', facepalm: '🤦', shrug: '🤷', hugging_face: '🤗', hugs: '🤗', handshake: '🤝', saluting_face: '🫡',
  heart_hands: '🫶', raised_hand: '✋', v: '✌️', crossed_fingers: '🤞', see_no_evil: '🙈', hourglass: '⌛', zap: '⚡', boom: '💥', trophy: '🏆',
  green_heart: '💚', blue_heart: '💙', yellow_heart: '💛', purple_heart: '💜', orange_heart: '🧡', white_heart: '🤍', black_heart: '🖤',
};
/** A Slack reaction name ("+1", "thumbsup::skin-tone-3") as an emoji, or null when it's one we don't know (or a custom one). */
export const slackEmoji = (name) => SLACK_EMOJI[String(name || '').replace(/::skin-tone-\d$/, '')] || null;

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
        messages.push({ ts: String(m.ts), user: m.user || null, name: m.user_profile?.real_name || users.get(m.user)?.name || m.username || 'Slack', text, thread_ts: m.thread_ts && m.thread_ts !== m.ts ? String(m.thread_ts) : null,
          reactions: (Array.isArray(m.reactions) ? m.reactions : []).map((r) => ({ name: String(r?.name || ''), users: Array.isArray(r?.users) ? r.users.map(String) : [] })),
          pinned: Array.isArray(m.pinned_to) && m.pinned_to.length > 0, edited: !!m.edited });
      }
    }
    messages.sort((a, b) => Number(a.ts) - Number(b.ts));
    return { name: String(c.name).slice(0, 80), topic: c.topic?.value || c.purpose?.value || null, archived: !!c.is_archived, messages };
  });
  return { users, channels };
}
