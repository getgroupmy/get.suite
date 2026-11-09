// "Kim is typing…" in Chat: who is typing where (a conversation, or a thread in it), kept for a few
// seconds after each sign (people send one every couple of seconds while they type).
export const TYPING_FOR = 6000;

const place = (channelId, parentId) => `${channelId}:${parentId || ''}`;

/** The state after a 'chat-typing' event (or a message from them, which ends their typing). */
export function noteTyping(state, ev, at = Date.now()) {
  const k = place(ev.channel_id, ev.parent_id);
  const here = { ...(state[k] || {}) };
  if (ev.stop) delete here[ev.user_id];
  else here[ev.user_id] = { name: ev.name || 'Someone', until: at + TYPING_FOR };
  return { ...state, [k]: here };
}

/** Names of the people typing in a place right now. */
export function typingIn(state, channelId, parentId, at = Date.now()) {
  return Object.values(state[place(channelId, parentId)] || {}).filter((t) => t.until > at).map((t) => t.name);
}

/** The line shown above the box. */
export function typingText(names) {
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
  return 'Several people are typing…';
}
