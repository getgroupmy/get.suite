// The timesheet: your tracked time on each task, for each day of a week.
// Timers are split at local midnight; time added by hand belongs to the day it was added for (its date, as typed).

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The seven days from `weekStart` (local midnight, ms): [{ start, end, date: 'YYYY-MM-DD' }]. */
export function weekDays(weekStart) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const a = new Date(weekStart); a.setDate(a.getDate() + i);
    const b = new Date(a); b.setDate(b.getDate() + 1);
    out.push({ start: a.getTime(), end: b.getTime(), date: ymd(a) });
  }
  return out;
}

/**
 * spans: [{ task_id, start, end } | { task_id, start, minutes, logged }]; tasks: [{ id, title, list_id }].
 * → { days, rows: [{ id, title, list_id, cells: [minutes × 7], total }], dayTotals: [× 7], total }, busiest task first.
 */
export function timesheet(spans, tasks, weekStart) {
  const days = weekDays(weekStart);
  const rows = new Map(tasks.map((t) => [t.id, { id: t.id, title: t.title, list_id: t.list_id, cells: days.map(() => 0), total: 0 }]));
  for (const s of spans || []) {
    const row = rows.get(s.task_id);
    if (!row) continue;
    days.forEach((d, i) => {
      let m;
      if (s.logged) m = new Date(s.start).toISOString().slice(0, 10) === d.date ? s.minutes : 0;
      else m = Math.max(0, Math.min(s.end, d.end) - Math.max(s.start, d.start)) / 60e3;
      row.cells[i] += m;
    });
  }
  const list = [...rows.values()].map((r) => {
    const cells = r.cells.map((m) => Math.round(m));
    return { ...r, cells, total: cells.reduce((a, b) => a + b, 0) };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
  const dayTotals = days.map((_, i) => list.reduce((n, r) => n + r.cells[i], 0));
  return { days, rows: list, dayTotals, total: dayTotals.reduce((a, b) => a + b, 0) };
}

/** "1:30" (hours:minutes), for the grid and the CSV; '' for none. */
export const hm = (min) => (min ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}` : '');

/** CSV for Excel or Sheets: Task, each day (hours, decimal), Total. */
export function timesheetCsv(sheet) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const h = (m) => (m ? (Math.round((m / 60) * 100) / 100).toString() : '');
  const lines = [['Task', ...sheet.days.map((d) => d.date), 'Total (h)']];
  for (const r of sheet.rows) lines.push([r.title, ...r.cells.map(h), h(r.total)]);
  lines.push(['Total', ...sheet.dayTotals.map(h), h(sheet.total)]);
  return `${lines.map((l) => l.map(q).join(',')).join('\r\n')}\r\n`;
}
