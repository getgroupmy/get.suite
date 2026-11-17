/**
 * A message's reactions after you tap one (offline: shown here until the server says): yours is added, or taken off
 * if it was there; an emoji nobody has any more goes.
 */
export function toggleReaction(reactions = [], emoji, me) {
  const had = reactions.find((r) => r.emoji === emoji);
  if (!had) return [...reactions, { emoji, users: [{ id: me.id, name: me.name }] }];
  const mine = had.users.some((u) => u.id === me.id);
  const users = mine ? had.users.filter((u) => u.id !== me.id) : [...had.users, { id: me.id, name: me.name }];
  return users.length ? reactions.map((r) => (r === had ? { ...r, users } : r)) : reactions.filter((r) => r !== had);
}
