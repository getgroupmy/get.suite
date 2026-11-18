// The bell's notifications under day headings: Today, Yesterday, Earlier this week (the 7 days before), Older.
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Which heading a time falls under, seen from `now`. */
export function dayHeading(ms, now = new Date()) {
  const today = startOfDay(now);
  if (ms >= today) return 'Today';
  const yesterday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  if (ms >= yesterday) return 'Yesterday';
  if (ms >= startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7))) return 'Earlier this week';
  return 'Older';
}

/** Newest-first notifications → [{ heading, items }], in order, leaving out empty ones. */
export function byDay(items, now = new Date()) {
  const out = [];
  for (const n of items) {
    const h = dayHeading(n.created_at, now);
    if (out.at(-1)?.heading === h) out.at(-1).items.push(n);
    else out.push({ heading: h, items: [n] });
  }
  return out;
}
