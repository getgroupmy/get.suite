// Picking a room for an event: what each one is like, and the best ones first.

/** True when the room has a size and fewer seats than the people coming. */
export const tooSmall = (room, people) => !!room.capacity && people > room.capacity;

/** A room in one line: "Boardroom (12) · 2nd floor · Video, Whiteboard". */
export function roomLine(room) {
  const parts = [`${room.name}${room.capacity ? ` (${room.capacity})` : ''}`];
  if (room.location) parts.push(room.location);
  if (room.features?.length) parts.push(room.features.join(', '));
  return parts.join(' · ');
}

/**
 * The rooms to offer, best first: free ones before ones we don't know about before taken ones, then
 * ones big enough for everyone, then the smallest that fits (so a big room is left for big meetings).
 */
export function sortRooms(rooms, people = 1) {
  const freeRank = (r) => (r.free === true ? 0 : r.free === false ? 2 : 1);
  return [...rooms].sort((a, b) => freeRank(a) - freeRank(b)
    || tooSmall(a, people) - tooSmall(b, people)
    || (a.capacity ?? Infinity) - (b.capacity ?? Infinity)
    || a.name.localeCompare(b.name));
}

/** "Video, whiteboard ,video" → ["Video", "whiteboard"]: what an admin types, as a list. */
export const readFeatures = (text) => {
  const out = [];
  for (const v of String(text).split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean)) if (!out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  return out;
};

/**
 * How a room is doing right now, for the rooms board: "Free until 3:20 PM", "Free for the next 12
 * hours", or "In use until 3:50 PM: Standup (Olivia Owner)". `time` formats a time of day.
 */
export function nowText(room, time) {
  if (room.busy) return `In use until ${time(room.busy.until)}: ${room.busy.title}${room.busy.organizer ? ` (${room.busy.organizer})` : ''}`;
  return room.next ? `Free until ${time(room.next.start)}` : 'Free for the next 12 hours';
}

/** Does the room have everything the meeting needs (ignoring case)? */
export const hasAll = (room, needs) => needs.every((n) => (room.features || []).some((f) => f.toLowerCase() === n.toLowerCase()));
