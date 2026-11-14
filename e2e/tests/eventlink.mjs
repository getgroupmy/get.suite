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

const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let general, ev, weekly, lee, kim;
await step('open an event from its link, copy the link, paste it in Chat', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  const t = new Date(); t.setDate(t.getDate() + 2); t.setHours(9, 0, 0, 0);
  ev = (await api(page, 'POST', '/events', { title: 'Launch review', start: t.getTime(), end: t.getTime() + 3600e3, location: 'Room 4', guests: ['kim@acme.com'] })).body;
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  await page.goto(`${B}/calendar?event=${ev.id}`);
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.waitFor();
  if (await d.getByLabel('Title').inputValue() !== 'Launch review') throw new Error('wrong event');
  if (page.url().includes('event=')) throw new Error('the link stays in the address');
  await d.getByRole('button', { name: 'Copy link' }).click();
  await page.getByText('Link to the event copied').waitFor();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  if (url !== `${B}/calendar?event=${ev.id}`) throw new Error(`copied ${url}`);
  await page.goto(`${B}/chat/${general}`);
  await page.getByLabel('Message', { exact: true }).fill(`Agenda for ${url}`);
  await page.getByLabel('Message', { exact: true }).press('Enter');
  const card = page.getByRole('link', { name: 'Event: Launch review' });
  await card.waitFor();
  const txt = await card.textContent();
  if (!/Room 4/.test(txt) || !/You organise it/.test(txt) || !/1 guest/.test(txt) || !/9:00/.test(txt)) throw new Error(txt);
  await page.screenshot({ path: `${SP}/shots/eventlink-card.png` });
});
await step('a guest opens it from the card: the invitation', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${general}`);
  const card = kim.getByRole('link', { name: 'Event: Launch review' });
  await card.waitFor();
  if (!/You haven’t answered/.test(await card.textContent())) throw new Error(await card.textContent());
  await card.click();
  await kim.getByRole('dialog', { name: 'Launch review' }).waitFor();
});
await step('one time of a repeating event', async () => {
  const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(14, 0, 0, 0);
  weekly = (await api(page, 'POST', '/events', { title: 'Weekly sync', start: t.getTime(), end: t.getTime() + 1800e3, rrule: { freq: 'weekly' } })).body;
  if (!weekly.id) throw new Error(JSON.stringify(weekly));
  const third = t.getTime() + 14 * 864e5;
  await page.goto(`${B}/calendar?event=${weekly.id}&at=${third}`);
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.waitFor();
  await d.getByRole('button', { name: 'Copy link' }).click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  if (url !== `${B}/calendar?event=${weekly.id}&at=${third}`) throw new Error(`copied ${url}`);
});
await step('someone who can’t see the event', async () => {
  lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  await lee.goto(`${B}/chat/${general}`);
  await lee.getByText('An event you can’t see').waitFor();
  if (await lee.getByText('Room 4').count()) throw new Error('Lee must not see it');
  await lee.goto(`${B}/calendar?event=${ev.id}`);
  await lee.getByText('That event isn’t in a calendar you can see').waitFor();
});
await step('Send in Chat…: the event goes into a conversation as a card', async () => {
  await page.goto(`${B}/calendar?event=${ev.id}`);
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.waitFor();
  const sw = await d.locator('.modal-body').evaluate((el) => el.scrollWidth - el.clientWidth);
  if (sw > 1) throw new Error(`the event window scrolls sideways by ${sw}px`);
  await page.screenshot({ path: `${SP}/shots/eventlink-buttons.png` });
  await d.getByRole('button', { name: 'Send in Chat…' }).click();
  const s = page.getByRole('dialog', { name: 'Send the event in Chat' });
  await s.waitFor();
  await s.getByRole('combobox').selectOption({ label: '# general' });
  await s.getByRole('button', { name: /Send|Open|Add/ }).last().click();
  await page.waitForURL(`**/chat/${general}`);
  const box = page.getByLabel('Message', { exact: true });
  await until(async () => (await box.inputValue()).includes(`/calendar?event=${ev.id}`));
  if (!(await box.inputValue()).startsWith('Launch review: ')) throw new Error(await box.inputValue());
  await box.press('Enter');
  await until(async () => (await page.getByRole('link', { name: 'Event: Launch review' }).count()) === 2);
});
await step('a guest sends it from the invitation too', async () => {
  await kim.goto(`${B}/calendar?event=${ev.id}`);
  const d = kim.getByRole('dialog', { name: 'Launch review' });
  await d.waitFor();
  await d.getByRole('button', { name: 'Send in Chat…' }).click();
  await kim.getByRole('dialog', { name: 'Send the event in Chat' }).waitFor();
});
await step('Kim answers the invitation on its card in Chat; the organiser gets no buttons', async () => {
  await kim.goto(`${B}/chat/${general}`);
  const answers = kim.getByRole('group', { name: 'Answer: Launch review' }).first();
  await answers.getByRole('button', { name: 'Yes' }).click();
  await kim.getByText('You’re going to Launch review').waitFor();
  await kim.getByRole('link', { name: 'Event: Launch review' }).first().getByText(/You’re going/).waitFor();
  if (await answers.getByRole('button', { name: 'Yes' }).getAttribute('aria-pressed') !== 'true') throw new Error('not marked');
  const mine = (await api(kim, 'GET', `/events/${ev.id}/preview`)).body.my_status;
  if (mine !== 'yes') throw new Error(mine);
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('link', { name: 'Event: Launch review' }).first().waitFor();
  if (await page.getByRole('group', { name: 'Answer: Launch review' }).count()) throw new Error('the organiser can answer');
});
await step('a repeating event’s card has no answer buttons (answered in Calendar)', async () => {
  const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(10, 0, 0, 0);
  const rep = (await api(page, 'POST', '/events', { title: 'Standup', start: t.getTime(), end: t.getTime() + 900e3, rrule: { freq: 'daily' }, guests: ['kim@acme.com'] })).body;
  await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `Standup: ${B}/calendar?event=${rep.id}` });
  await kim.goto(`${B}/chat/${general}`);
  await kim.getByRole('link', { name: 'Event: Standup' }).waitFor();
  if (await kim.getByRole('group', { name: 'Answer: Standup' }).count()) throw new Error('buttons on a repeating event');
});
await step('the event card keeps up: Kim says no elsewhere, Olivia’s open card shows nobody going', async () => {
  await page.goto(`${B}/chat/${general}`);
  const card = page.getByRole('link', { name: 'Event: Launch review' }).first();
  await until(async () => /1 going/.test(await card.textContent()));
  await api(kim, 'POST', `/events/${ev.id}/rsvp`, { status: 'no' });
  await until(async () => !/going/.test(await card.textContent()), 10000);
});
await step('Chat with guests: the event’s own channel, for Olivia and Kim; the same one from Kim’s invitation', async () => {
  await page.goto(`${B}/calendar?event=${ev.id}`);
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByRole('button', { name: 'Chat with guests' }).click();
  await page.waitForURL(/\/chat\/[\w-]+$/);
  const chanId = page.url().split('/chat/')[1];
  await page.getByText('A channel for this event, with everyone invited from your company').waitFor();
  await page.getByRole('heading', { name: /launch-review/ }).first().waitFor();
  await page.getByRole('link', { name: 'Event: Launch review' }).first().waitFor();
  await kim.goto(`${B}/calendar?event=${ev.id}`);
  const inv = kim.getByRole('dialog', { name: 'Launch review' });
  await inv.getByRole('button', { name: 'Chat with guests' }).click();
  await kim.waitForURL(`**/chat/${chanId}`);
  await kim.getByRole('link', { name: 'Event: Launch review' }).first().waitFor();
  if (await lee.goto(`${B}/chat/${chanId}`).then(() => lee.getByText('Launch review').count())) throw new Error('Lee sees it');
});
await step('the event’s channel says what it’s about at the top, and opens the event', async () => {
  const chan = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.about_kind === 'event');
  await page.goto(`${B}/chat/${chan.id}`);
  await page.getByText('· this channel’s event').waitFor();
  await page.getByRole('link', { name: 'Launch review', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit event' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
