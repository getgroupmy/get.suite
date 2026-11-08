// Grouped rows and columns: a sheet keeps `groups: [{ axis: 'row'|'col', from, to, collapsed }]`
// (0-based, inclusive), left out when there are none. A collapsed group hides its rows or columns
// (on top of any hidden by hand), and its − / + sits just after it. Groups don't overlap.

const tidy = (list) => (list.length ? list.sort((a, b) => (a.axis === b.axis ? a.from - b.from : a.axis < b.axis ? -1 : 1)) : null);

/** Groups with `from`..`to` on an axis added; refused (null) when it overlaps one already there. */
export function addGroup(groups, axis, from, to) {
  const list = groups || [];
  if (to < from || from < 0) return null;
  if (list.some((g) => g.axis === axis && g.from <= to && from <= g.to)) return null;
  return tidy([...list, { axis, from, to, collapsed: false }]);
}

/** Groups without the ones touching `from`..`to` on an axis (null when none are left). */
export const removeGroups = (groups, axis, from, to) => tidy((groups || []).filter((g) => !(g.axis === axis && g.from <= to && from <= g.to)));

/** Collapse or expand the group starting at `from` on an axis. */
export const toggleGroup = (groups, axis, from) => (groups || []).map((g) => (g.axis === axis && g.from === from ? { ...g, collapsed: !g.collapsed } : g));

/** The indexes collapsed groups hide on an axis. */
export function collapsedOn(groups, axis) {
  const out = new Set();
  for (const g of groups || []) if (g.axis === axis && g.collapsed) for (let i = g.from; i <= g.to; i++) out.add(i);
  return out;
}

/** Groups on an axis by the index of their − / + (just after the group): Map(index → group). */
export function toggleAt(groups, axis) {
  return new Map((groups || []).filter((g) => g.axis === axis).map((g) => [g.to + 1, g]));
}

/** Groups after inserting or deleting rows/columns (see structure.js): they move, stretch or shrink. */
export function adjustGroups(groups, change) {
  if (!groups) return groups;
  const ax = change.axis;
  const out = [];
  for (const g of groups) {
    if (g.axis !== ax) { out.push(g); continue; }
    let { from, to } = g;
    if (change.count > 0) {
      if (change.at <= from) { from += change.count; to += change.count; } else if (change.at <= to) to += change.count;
    } else {
      const a = change.at, b = change.at - change.count - 1; // deleted a..b
      const gone = Math.max(0, Math.min(to, b) - Math.max(from, a) + 1);
      if (gone === to - from + 1) continue; // all of it deleted
      const before = Math.max(0, Math.min(from, b + 1) - a); // deleted rows before it
      from -= Math.max(0, before);
      to -= before + gone;
    }
    out.push({ ...g, from, to });
  }
  return tidy(out);
}
