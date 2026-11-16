/** What a change kept offline is, in words, for Settings → This device: "Add a task: “Buy sun cream”". */
const WHAT = [
  [/^\/tasks\/lists\/[^/]+\/tasks$/, 'POST', 'Add a task'], [/^\/tasks\/tasks\/[^/]+$/, 'PATCH', 'Change a task'], [/^\/tasks\/tasks\/[^/]+$/, 'DELETE', 'Delete a task'],
  [/^\/notes$/, 'POST', 'Take a note'], [/^\/notes\/[^/]+$/, 'PATCH', 'Change a note'], [/^\/notes\/[^/]+$/, 'DELETE', 'Delete a note'],
  [/^\/contacts$/, 'POST', 'Add a contact'], [/^\/contacts\/[^/]+$/, 'PATCH', 'Change a contact'], [/^\/contacts\/[^/]+$/, 'DELETE', 'Delete a contact'],
  [/^\/events$/, 'POST', 'Add an event'], [/^\/events\/[^/]+$/, 'PATCH', 'Change an event'],
  [/^\/chat\/channels\/[^/]+\/messages$/, 'POST', 'Send a chat message'],
  [/^\/mail\/messages\/move$/, 'POST', 'Move mail'], [/^\/mail\/messages\/delete$/, 'POST', 'Delete mail'],
];
export function changeText(c) {
  let what = WHAT.find(([re, m]) => m === c.method && re.test(c.url))?.[2];
  if (!what && c.method === 'POST' && c.url === '/mail/messages/flags') {
    const b = c.body || {};
    what = b.seen === true ? 'Mark mail read' : b.seen === false ? 'Mark mail unread' : b.flagged === true ? 'Star mail' : b.flagged === false ? 'Unstar mail' : 'Change mail';
  }
  if (what === 'Move mail' && c.body?.to === 'archive') what = 'Archive mail';
  if (what === 'Send a chat message' && c.body?.body) return `${what}: “${String(c.body.body).slice(0, 60)}”`;
  return `${what || 'A change'}${c.label ? `: “${c.label}”` : ''}`;
}
