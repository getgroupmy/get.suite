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
const kim = await mk('kim');
let kimId, busy;
await step('Kim is busy at the start of the next working day', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  await signIn(kim, 'kim@acme.com');
  busy = await kim.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 1); while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); });
  await api(kim, 'POST', '/events', { title: 'Kim busy', start: busy, end: busy + 3600e3 });
});
await step('Kim’s card → Schedule a meeting: a new event with Kim invited, at the first half hour both are free', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Directory' }).click();
  await page.getByRole('button', { name: 'Kim Park', exact: true }).click();
  await page.getByRole('dialog', { name: 'Kim Park' }).getByRole('button', { name: 'Schedule a meeting' }).click();
  await page.waitForURL(/\/calendar/);
  const expected = await page.evaluate(async (id) => (await (await fetch(`/api/freebusy/suggest?users=${id}&duration=30&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`)).json()).slots[0], kimId);
  if (expected.start < busy + 3600e3 && expected.start + 30 * 60e3 > busy) throw new Error('suggested while Kim is busy');
  const when = await page.evaluate((t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), expected.start);
  await page.getByText(`The first half hour you’re both free: ${when}`).waitFor();
  const d = page.getByRole('dialog').last();
  await d.getByText('Kim Park').first().waitFor();
  const startInput = await d.locator('input[type="time"]').first().inputValue();
  const want = await page.evaluate((t) => { const x = new Date(t); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; }, expected.start);
  if (startInput !== want) throw new Error(`${startInput} vs ${want}`);
});
await step('saving it invites Kim', async () => {
  await page.getByRole('dialog').last().getByLabel('Title').fill('Catch-up');
  await page.getByRole('dialog').last().getByRole('button', { name: 'Save' }).click();
  await until(async () => (await api(kim, 'GET', `/events?from=${busy - 864e5}&to=${busy + 7 * 864e5}`)).body.some((e) => e.title === 'Catch-up'));
});
await step('Chat: a direct message’s 📅 plans a meeting with Kim', async () => {
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await page.goto(`${B}/chat/${dm}`);
  await page.getByRole('button', { name: 'Schedule a meeting with this conversation' }).click();
  await page.waitForURL(/\/calendar/);
  await page.getByText(/^The first half hour you’re both free: /).waitFor();
  await page.getByRole('dialog').last().getByText('Kim Park').first().waitFor();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Close' }).click().catch(() => page.keyboard.press('Escape'));
});
await step('saving it posts the event in the direct message, as a card', async () => {
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await page.goto(`${B}/chat/${dm}`);
  await page.getByRole('button', { name: 'Schedule a meeting with this conversation' }).click();
  await page.waitForURL(/\/calendar/);
  const d = page.getByRole('dialog').last();
  await d.getByLabel('Title').fill('Coffee');
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Posted in the conversation too').waitFor();
  await page.goto(`${B}/chat/${dm}`);
  await page.locator('.msg', { hasText: '📅 Coffee:' }).first().waitFor();
  await page.locator('.messages').getByText('Coffee', { exact: true }).first().waitFor();
  await kim.goto(`${B}/chat/${dm}`);
  await kim.locator('.msg', { hasText: '📅 Coffee:' }).first().waitFor();
});
await step('a private channel’s: everyone in it, its name as the title; #general has none', async () => {
  const maxId = (await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' })).body.id;
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'launch-team', private: true, members: [kimId, maxId] })).body;
  await page.goto(`${B}/chat/${ch.id || ch.channel?.id}`);
  await page.getByRole('button', { name: 'Schedule a meeting with this conversation' }).click();
  await page.waitForURL(/\/calendar/);
  await page.getByText(/^The first half hour you’re all free: /).waitFor();
  const d = page.getByRole('dialog').last();
  if (await d.getByLabel('Title').inputValue() !== 'launch-team') throw new Error(await d.getByLabel('Title').inputValue());
  await d.getByText('Kim Park').first().waitFor();
  await d.getByText('Max Meet').first().waitFor();
  const general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await page.getByRole('button', { name: 'Download conversation' }).waitFor();
  if (await page.getByRole('button', { name: 'Schedule a meeting with this conversation' }).count()) throw new Error('offered in #general');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
