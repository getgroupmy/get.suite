// Where the "New messages" line goes when a conversation opens: before the first message someone
// else sent after you last read it. None when nothing is new, or when everything shown is new
// because you've never opened it (a line above the first message says nothing).
export function newFromId(messages, readAt, meId) {
  const i = messages.findIndex((m) => m.user_id !== meId && m.created_at > (readAt || 0));
  if (i < 0 || (i === 0 && readAt == null)) return null;
  return messages[i].id;
}

export function newCount(messages, fromId, meId) {
  const i = messages.findIndex((m) => m.id === fromId);
  return i < 0 ? 0 : messages.slice(i).filter((m) => m.user_id !== meId).length;
}

// The button that appears when messages arrive below what you're reading.
export const belowText = (n) => `↓ ${n} new message${n === 1 ? '' : 's'}`;
