// Quick actions in the top bar's search: type what you want to do ("new doc", "compose", "event")
// and it's offered first. Each has words it answers to; every word typed must start one of them.
export const ACTIONS = [
  { key: 'doc', title: 'New document', icon: 'doc', words: 'new document doc write docs', make: 'doc' },
  { key: 'sheet', title: 'New spreadsheet', icon: 'sheet', words: 'new spreadsheet sheet sheets excel table', make: 'sheet' },
  { key: 'slides', title: 'New presentation', icon: 'slides', words: 'new presentation slides deck powerpoint', make: 'slides' },
  { key: 'mail', title: 'Write an email', icon: 'mail', words: 'new email compose write message mail send', to: '/mail?compose=', needsMail: true },
  { key: 'event', title: 'New event', icon: 'calendar', words: 'new event meeting calendar appointment schedule', event: true },
  { key: 'task', title: 'Tasks', icon: 'check', words: 'new task tasks todo to-do', to: '/tasks' },
  { key: 'note', title: 'Notes', icon: 'note', words: 'new note notes keep', to: '/notes' },
  { key: 'meet', title: 'Start a video meeting', icon: 'video', words: 'new meet meeting video call', to: '/meet' },
  { key: 'settings', title: 'Settings', icon: 'settings', words: 'settings preferences password account signature', to: '/settings' },
  { key: 'admin', title: 'Admin', icon: 'shield', words: 'admin users people company', to: '/admin', adminOnly: true },
];

/** The actions that answer to what was typed (each word must start one of theirs), at most `max`. */
export function matchActions(text, { mail = true, admin = false, max = 3 } = {}) {
  const typed = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!typed.length || typed.join('').length < 2) return [];
  return ACTIONS.filter((a) => (mail || !a.needsMail) && (admin || !a.adminOnly))
    .filter((a) => { const words = `${a.title} ${a.words}`.toLowerCase().split(/\s+/); return typed.every((t) => words.some((w) => w.startsWith(t))); })
    .slice(0, max);
}
