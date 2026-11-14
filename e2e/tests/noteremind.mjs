import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
let note;
const card = (name) => page.getByRole('article', { name });
await step('a note; set a reminder from the menu', async () => {
  note = (await api(page, 'POST', '/notes', { title: 'Renew permit', body: 'Form is in the drawer' })).body;
  await page.goto(`${B}/notes`);
  await card('Renew permit').getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: /^Tomorrow · / }).click();
  await card('Renew permit').getByText(/⏰ Tomorrow,/).waitFor();
  await page.getByText(/Reminder set for Tomorrow/).waitFor();
});
await step('pick a day and time', async () => {
  await card('Renew permit').getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: 'Pick a day and time…' }).click();
  const d = new Date(Date.now() + 3 * 864e5); d.setHours(9, 30, 0, 0);
  const pad = (x) => String(x).padStart(2, '0');
  await page.getByLabel('Day and time').fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:30`);
  await page.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await api(page, 'GET', '/notes')).body[0].remind_at === d.getTime());
});
await step('Reminders view lists it; remove it', async () => {
  await page.locator('.subnav').getByRole('button', { name: 'Reminders' }).click();
  await card('Renew permit').waitFor();
  await card('Renew permit').getByRole('button', { name: 'Remove reminder' }).click();
  await page.getByText('No reminders set').waitFor();
});
await step('when it is due: a notification', async () => {
  await api(page, 'PATCH', `/notes/${note.id}`, { remind_at: Date.now() + 2000 });
  await page.getByRole('button', { name: /Notifications, 1 new/ }).waitFor({ timeout: 40000 });
  await page.getByRole('button', { name: /Notifications, 1 new/ }).click();
  await page.getByText('Reminder: Renew permit').waitFor();
  await until(async () => (await api(page, 'GET', '/notes')).body[0].remind_at === null);
});
await step('repeat weekly: 🔁 on the card; when it goes off, it moves on a week', async () => {
  await page.goto(`${B}/notes`);
  await card('Renew permit').getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: /^Tomorrow · / }).click();
  await card('Renew permit').getByText(/⏰ Tomorrow,/).waitFor();
  await card('Renew permit').getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: 'Repeat weekly' }).click();
  await card('Renew permit').getByLabel('repeats weekly').waitFor();
  const n = (await api(page, 'GET', '/notes')).body[0];
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (n.remind_repeat !== 'weekly' || !tz) throw new Error(JSON.stringify(n));
  await card('Renew permit').getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: '✓ Repeat weekly' }).waitFor();
  await page.keyboard.press('Escape');
  // Due in two seconds: the notification, and the next one a week on.
  const soon = Date.now() + 2000;
  await api(page, 'PATCH', `/notes/${note.id}`, { remind_at: soon });
  await until(async () => { const x = (await api(page, 'GET', '/notes')).body[0]; return x.remind_at && x.remind_at > soon + 6 * 864e5; }, 40000);
  const x = (await api(page, 'GET', '/notes')).body[0];
  if (Math.abs(x.remind_at - soon - 7 * 864e5) > 3600e3 || x.remind_repeat !== 'weekly') throw new Error(JSON.stringify(x));
  const bells = (await api(page, 'GET', '/notifications')).body.items.filter((i) => i.title === 'Reminder: Renew permit');
  if (bells.length !== 2) throw new Error(`${bells.length} reminders`);
  await page.screenshot({ path: `${SP}/shots/note-repeat.png` });
});
await step('a daily checklist that starts again: Untick the list each time', async () => {
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const c = (await api(page, 'POST', '/notes', { title: 'Opening checks', items: [{ text: 'Lights on' }, { text: 'Till float' }] })).body;
  await api(page, 'PATCH', `/notes/${c.id}`, { remind_at: Date.now() + 864e5, remind_repeat: 'daily', remind_tz: tz });
  await page.goto(`${B}/notes`);
  await card('Opening checks').getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: 'Untick the list each time' }).click();
  await until(async () => (await api(page, 'GET', '/notes')).body.find((x) => x.id === c.id).remind_reset === true);
  const items = (await api(page, 'GET', '/notes')).body.find((x) => x.id === c.id).items;
  await api(page, 'PATCH', `/notes/${c.id}`, { items: items.map((i) => ({ ...i, done: true })) });
  await card('Opening checks').getByText('2 ticked items').waitFor();
  await api(page, 'PATCH', `/notes/${c.id}`, { remind_at: Date.now() + 2000 });
  await until(async () => (await card('Opening checks').getByRole('checkbox', { checked: false }).count()) === 2, 40000);
  if (await card('Opening checks').getByText(/ticked item/).count()) throw new Error('still ticked');
});
await step('Pick a day and time… with Repeat weekly and Untick the list each time, in one go', async () => {
  const c = (await api(page, 'POST', '/notes', { title: 'Bins out', items: [{ text: 'Green bin' }, { text: 'Grey bin' }] })).body;
  await page.goto(`${B}/notes`);
  await card('Bins out').getByRole('button', { name: 'Remind me' }).click();
  await page.getByRole('menuitem', { name: 'Pick a day and time…' }).click();
  const d = new Date(Date.now() + 2 * 864e5); d.setHours(19, 0, 0, 0);
  const pad = (x) => String(x).padStart(2, '0');
  const dlg = page.getByRole('dialog', { name: 'Remind me' });
  await dlg.getByLabel('Day and time').fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T19:00`);
  if (await dlg.getByLabel('Untick the list each time').count()) throw new Error('shown before repeating');
  await dlg.getByLabel('Repeat').selectOption({ label: 'Weekly' });
  await dlg.getByLabel('Untick the list each time').check();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/Reminder set for .*, repeat weekly/).waitFor();
  const n = (await api(page, 'GET', '/notes')).body.find((x) => x.id === c.id);
  if (n.remind_at !== d.getTime() || n.remind_repeat !== 'weekly' || n.remind_reset !== true) throw new Error(JSON.stringify(n));
  await card('Bins out').getByLabel('repeats weekly').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
