// What a task says under its title in search results: its list, when it's due (overdue said so), who it's for, how
// important (as the search sends it: priority 'high', 'medium' or 'low'). today is YYYY-MM-DD in your own time zone.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const days = (a, b) => Math.round((Date.UTC(...b.split('-').map((n, i) => n - (i === 1))) - Date.UTC(...a.split('-').map((n, i) => n - (i === 1)))) / 864e5);

/** "due today", "due tomorrow", "due Fri 28 Nov" (this week), "due 3 Jan 2027" (another year), "overdue since 21 Nov". */
export function dueText(due, today, time) {
  if (!due) return null;
  const d = days(today, due);
  const [y, m, dd] = due.split('-').map(Number);
  const date = `${dd} ${MONTHS[m - 1]}${y !== Number(today.slice(0, 4)) ? ` ${y}` : ''}`;
  const at = time ? ` ${time}` : '';
  if (d < 0) return `overdue since ${d === -1 ? 'yesterday' : date}`;
  if (d === 0) return `due today${at}`;
  if (d === 1) return `due tomorrow${at}`;
  if (d < 7) return `due ${new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${date}${at}`;
  return `due ${date}${at}`;
}

export function taskSub(t, today) {
  const said = t.comment_match ? String(t.comment_match).replace(/\s+/g, ' ').trim() : ''; // the comment that found it
  return [said && `💬 “${said.length > 60 ? `${said.slice(0, 59)}…` : said}”`, t.list_name, !t.done_at && dueText(t.due, today, t.due_time), t.assignee_name, !t.done_at && ['high', 'medium', 'low'].includes(t.priority) && `${t.priority} priority`, !t.done_at && t.important && '★']
    .filter(Boolean).join(' · ');
}
