// A task's history, as sentences: "Ana Silva moved the due date from 1 Dec to 3 Dec".
import { repeatText } from './taskmath.js';

const minutes = (min) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`; };
const PRIORITY = { high: 'High', medium: 'Medium', low: 'Low' };
const STATUS = { todo: 'To do', progress: 'In progress', done: 'Done' };
const quote = (s) => `“${s.length > 60 ? `${s.slice(0, 59)}…` : s}”`;

/** "3 Dec" (with the year when it isn't this year), and the time when there is one: "3 Dec, 15:00". */
export function dayText(v, now = new Date(), locale) {
  const [day, time] = String(v).split(' ');
  const d = new Date(`${day}T00:00:00Z`);
  const year = d.getUTCFullYear() !== now.getFullYear();
  const text = d.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(year && { year: 'numeric' }), timeZone: 'UTC' });
  return time ? `${text}, ${time}` : text;
}

const fromTo = (what, a, b, show) => (a == null && b != null ? `set the ${what} to ${show(b)}`
  : b == null ? `took the ${what} off (was ${show(a)})`
    : `changed the ${what} from ${show(a)} to ${show(b)}`);

/** What someone did, without their name: "ticked it off". `me` is the viewer's id ("you"). */
export function historyText(e, { now = new Date(), locale, me } = {}) {
  const day = (v) => dayText(v, now, locale);
  const { before: a, after: b } = e;
  const person = (p) => (p.id === me ? 'you' : p.name);
  switch (e.field) {
    case 'title': return `renamed it from ${quote(a)} to ${quote(b)}`;
    case 'notes': return b ? 'changed the notes' : 'cleared the notes';
    case 'due': return fromTo('due date', a, b, day);
    case 'start': return fromTo('start date', a, b, day);
    case 'assignee':
      if (!b) return `took it off ${person(a)}`;
      if (b.id === e.user.id) return a ? `took it on (it was for ${person(a)})` : 'took it on';
      return a ? `gave it to ${person(b)} (it was for ${person(a)})` : `gave it to ${person(b)}`;
    case 'status':
      if (b === 'done') return 'ticked it off';
      if (a === 'done') return b === 'progress' ? 'brought it back, in progress' : 'brought it back to do';
      return `moved it from ${STATUS[a]} to ${STATUS[b]}`;
    case 'priority': return fromTo('priority', a, b, (v) => PRIORITY[v] || v);
    case 'important': return b ? 'marked it important' : 'took the star off';
    case 'list': return `moved it from ${a} to ${b}`;
    case 'section': return b ? `moved it to the section ${quote(b)}` : `took it out of the section ${quote(a)}`;
    case 'repeat': return !b ? 'stopped it repeating' : `made it repeat: ${repeatText(b).toLowerCase()}`;
    case 'estimate': return fromTo('estimate', a, b, minutes);
    case 'tags': {
      const added = b.filter((t) => !a.includes(t)), removed = a.filter((t) => !b.includes(t));
      const tags = (l) => l.map((t) => `#${t}`).join(', ');
      return [added.length && `added ${tags(added)}`, removed.length && `removed ${tags(removed)}`].filter(Boolean).join(' and ') || 'changed the tags';
    }
    default: return 'changed it';
  }
}
