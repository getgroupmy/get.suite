// The same person with Workspace open in two places (a computer and a phone, or two tabs): a change made in
// one shows in the other without reloading. Each change is made through the API, as the other device would.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const found = [];
const shows = async (what, loc, ms = 8000) => { try { await loc.first().waitFor({ timeout: ms }); } catch { found.push(what); } };
const gone = async (what, loc, ms = 8000) => { try { await loc.first().waitFor({ state: 'detached', timeout: ms }); } catch { found.push(what); } };

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});

await step('Tasks: added and ticked elsewhere', async () => {
  const list = (await api('POST', '/tasks/lists', { name: 'Two places' })).body;
  await page.goto(`${B}/tasks/${list.id}`);
  await page.getByLabel('Add a task').waitFor();
  const t = (await api('POST', `/tasks/lists/${list.id}/tasks`, { title: 'Added on the phone' })).body;
  await shows('tasks: a new task', page.getByText('Added on the phone'));
  const done = await api('PATCH', `/tasks/tasks/${t.id}`, { done: true });
  if (done.status !== 200) throw new Error(`ticking: ${done.status}`);
  await page.waitForTimeout(500);
  await shows('tasks: ticked (moved to Completed)', page.getByText('Completed (1)'));
});

await step('Notes: written elsewhere', async () => {
  await page.goto(`${B}/notes`);
  await page.waitForTimeout(1000);
  const n = (await api('POST', '/notes', { title: 'From the phone', body: 'Milk and eggs' })).body;
  await shows('notes: a new note', page.getByText('From the phone'));
  const ch = await api('PATCH', `/notes/${n.id}`, { title: 'From the phone, changed' });
  if (ch.status !== 200) throw new Error(`changing the note: ${ch.status}`);
  await shows('notes: a changed note', page.getByText('From the phone, changed'));
});

await step('Calendar: an event added elsewhere', async () => {
  await page.goto(`${B}/calendar`);
  await page.waitForTimeout(1000);
  const d = new Date(); d.setHours(11, 0, 0, 0);
  await api('POST', '/events', { title: 'Phone-made meeting', start: d.getTime(), end: d.getTime() + 3600e3 });
  await shows('calendar: a new event', page.getByText('Phone-made meeting'));
});

await step('Contacts: added elsewhere', async () => {
  await page.goto(`${B}/contacts`);
  await page.waitForTimeout(1000);
  await api('POST', '/contacts', { name: 'Phoebe Phone' });
  await shows('contacts: a new contact', page.getByText('Phoebe Phone'));
});

await step('Drive: a file renamed and a new one elsewhere', async () => {
  const f = (await api('POST', '/files/new', { kind: 'doc', name: 'Before rename' })).body;
  await page.goto(`${B}/drive`);
  await page.getByText('Before rename').first().waitFor();
  const rn = await api('PATCH', `/files/${f.id}`, { name: 'After rename' });
  if (rn.status !== 200) throw new Error(`renaming: ${rn.status}`);
  await shows('drive: renamed', page.getByText('After rename'));
  await api('POST', '/files/new', { kind: 'sheet', name: 'Made on the laptop' });
  await shows('drive: a new file', page.getByText('Made on the laptop'));
});

await step('deleted or moved elsewhere: a note, an event, a contact, a file, a list renamed', async () => {
  const n = (await api('POST', '/notes', { title: 'Note to remove' })).body;
  await page.goto(`${B}/notes`);
  await page.getByText('Note to remove').first().waitFor();
  await api('DELETE', `/notes/${n.id}`);
  await gone('notes: deleted', page.getByText('Note to remove'));

  const d = new Date(); d.setHours(14, 0, 0, 0);
  const ev = (await api('POST', '/events', { title: 'Event to cancel', start: d.getTime(), end: d.getTime() + 3600e3 })).body;
  await page.goto(`${B}/calendar`);
  await page.getByText('Event to cancel').first().waitFor();
  await api('DELETE', `/events/${ev.id}`);
  await gone('calendar: deleted', page.getByText('Event to cancel'));

  const c = (await api('POST', '/contacts', { name: 'Contact To Remove' })).body;
  await page.goto(`${B}/contacts`);
  await page.getByText('Contact To Remove').first().waitFor();
  await api('DELETE', `/contacts/${c.id}`);
  await gone('contacts: deleted', page.getByText('Contact To Remove'));

  const f = (await api('POST', '/files/new', { kind: 'doc', name: 'File to bin' })).body;
  await page.goto(`${B}/drive`);
  await page.getByText('File to bin').first().waitFor();
  await api('POST', `/files/${f.id}/trash`).then((r) => r.status >= 400 ? api('DELETE', `/files/${f.id}`) : r);
  await gone('drive: put in the bin', page.getByText('File to bin'));

  const list = (await api('POST', '/tasks/lists', { name: 'Old list name' })).body;
  await page.goto(`${B}/tasks/${list.id}`);
  await page.getByText('Old list name').first().waitFor();
  await api('PATCH', `/tasks/lists/${list.id}`, { name: 'New list name' });
  await shows('tasks: list renamed', page.getByText('New list name'));
});

await step('read elsewhere: the bell and chat unread counts', async () => {
  const general = (await api('GET', '/chat/channels')).body.channels.find((c) => c.name === 'general');
  // Someone else writes in #general; Olivia reads it on her phone.
  await api('POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const other = await browser.newContext();
  const kp = await other.newPage();
  await kp.request.post(`${B}/api/auth/login`, { data: { username: 'kim@acme.com', password: 'password123' }, headers: { 'x-requested-with': 'nas-workspace' } });
  await kp.request.post(`${B}/api/chat/channels/${general.id}/join`, { headers: { 'x-requested-with': 'nas-workspace' } }).catch(() => {});
  await page.goto(`${B}/drive`);
  await page.waitForTimeout(1000);
  for (let i = 0; i < 2; i++) await kp.request.post(`${B}/api/chat/channels/${general.id}/messages`, { data: { body: `Hello @olivia@acme.com number ${i}` }, headers: { 'x-requested-with': 'nas-workspace' } });
  await other.close();
  const badge = page.locator('a[href="/chat"] .badge, a[href^="/chat"] .badge, [aria-label*="unread" i]').first();
  await badge.waitFor({ timeout: 8000 }).catch(() => found.push('chat: no unread count arrived'));
  const bellBefore = (await api('GET', '/notifications')).body;
  console.log('unread bell before', bellBefore.unread);
  // read on the phone
  const ms = (await api('GET', `/chat/channels/${general.id}/messages`)).body;
  const last = (ms.messages || ms).at(-1);
  const rr = await api('POST', `/chat/channels/${general.id}/read`, { message_id: last?.id });
  console.log('chat read', rr.status);
  await api('POST', '/notifications/read', { all: true }).then((r) => console.log('bell read', r.status));
  await gone('chat: unread count cleared', page.locator('a[href="/chat"] .badge, a[href^="/chat"] .badge'), 8000);
  const bellBadge = page.locator('.bell .badge, button[aria-label^="Notifications"] .badge');
  await gone('bell: count cleared', bellBadge, 8000);
});

await step('everything followed', async () => { if (found.length) throw new Error(found.join(' | ')); });
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
