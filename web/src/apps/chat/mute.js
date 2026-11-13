// Muting a conversation for a while.

/** How long to mute a conversation: [label, until (ms) or null for until unmuted]. */
export function muteChoices(now = new Date()) {
  const t = now.getTime();
  const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0).getTime();
  return [['For 1 hour', t + 3600e3], ['For 8 hours', t + 8 * 3600e3], ['Until tomorrow morning', morning], ['For a week', t + 7 * 864e5], ['Until I unmute', null]];
}
