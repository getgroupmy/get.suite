// The org chart from the Directory: who reports to whom, as a tree. People whose manager isn't in
// the list (or who have none) are at the top; names sort alphabetically at each level.
export function orgTree(people) {
  const byId = new Map(people.map((p) => [p.id, { ...p, reports: [] }]));
  const tops = [];
  for (const p of byId.values()) {
    const m = p.manager_id && p.manager_id !== p.id ? byId.get(p.manager_id) : null;
    if (m) m.reports.push(p); else tops.push(p);
  }
  const sort = (list) => { list.sort((a, b) => a.name.localeCompare(b.name)); for (const p of list) sort(p.reports); return list; };
  // Managers with people under them first at the top level, then everyone on their own.
  return sort(tops).sort((a, b) => (b.reports.length > 0) - (a.reports.length > 0));
}
/** Someone's chain of managers, nearest first. */
export function chainOf(people, id) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const out = [];
  for (let cur = byId.get(byId.get(id)?.manager_id); cur && out.length < 50 && !out.includes(cur); cur = byId.get(cur.manager_id)) out.push(cur);
  return out;
}
