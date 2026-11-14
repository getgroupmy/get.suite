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
let general, ids = [];
await step('a saved chat message shows on Home; it opens the message', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  for (const b of ['Book the venue by Friday', 'Send the **slides** to Raj']) ids.push((await api(page, 'POST', `/chat/channels/${general}/messages`, { body: b })).body.id);
  for (const id of ids) if ((await api(page, 'PUT', `/chat/messages/${id}/saved`, { saved: true })).status !== 200) throw new Error('save');
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: 'Saved in Chat' });
  await card.waitFor();
  await card.getByText('Send the slides to Raj').waitFor();
  await card.getByText('Book the venue by Friday').waitFor();
  await card.getByText('#general').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/home-saved.png` });
  await card.getByRole('link', { name: /Book the venue/ }).click();
  await page.waitForURL(`**/chat/${general}?msg=${ids[0]}`);
  await page.locator('.msg', { hasText: 'Book the venue by Friday' }).waitFor();
});
await step('✓ takes it off Saved; the title opens Saved in Chat', async () => {
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: 'Saved in Chat' });
  await card.getByRole('button', { name: 'Done with: Book the venue by Friday' }).click();
  await until(async () => !(await card.getByText('Book the venue by Friday').count()));
  const left = (await api(page, 'GET', '/chat/saved')).body.map((x) => x.message_id);
  if (left.join() !== ids[1]) throw new Error(left.join());
  await card.getByRole('link', { name: /Saved in Chat/ }).click();
  await page.waitForURL('**/chat?saved=1');
  await page.getByRole('heading', { name: 'Saved', exact: true }).waitFor();
  await page.getByText(/Send the .*slides.* to Raj/).first().waitFor();
});
await step('Customize lists it; the last one done hides the card', async () => {
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: 'Saved in Chat' });
  await card.getByRole('button', { name: /^Done with:/ }).click();
  await until(async () => !(await page.getByRole('region', { name: 'Saved in Chat' }).count()));
  await page.getByRole('button', { name: 'Customize' }).click();
  await page.getByRole('dialog').getByText('Saved in Chat').waitFor();
});
await step('Chat reminders: a reminder set in Chat shows on Home live, soonest first; ✕ cancels it', async () => {
  const a = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'Call the supplier back' })).body.id;
  const b = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'Check the stock count' })).body.id;
  await page.goto(`${B}/home`);
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  if (await page.getByRole('region', { name: 'Chat reminders' }).count()) throw new Error('none yet');
  // Set while Home is open: it comes in by itself.
  const later = new Date(); later.setDate(later.getDate() + 1); later.setHours(9, 0, 0, 0);
  await api(page, 'POST', `/chat/messages/${b}/remind`, { at: later.getTime() + 3600e3 });
  await api(page, 'POST', `/chat/messages/${a}/remind`, { at: later.getTime() });
  const card = page.getByRole('region', { name: 'Chat reminders' });
  await until(async () => (await card.locator('li').count()) === 2);
  const rows = await card.locator('li').allInnerTexts();
  if (!/tomorrow at 9:00/.test(rows[0]) || !/Call the supplier back/.test(rows[0]) || !/Check the stock count/.test(rows[1])) throw new Error(rows.join(' | '));
  await card.getByRole('button', { name: 'Cancel reminder: Call the supplier back' }).click();
  await until(async () => (await card.locator('li').count()) === 1);
  if ((await api(page, 'GET', '/chat/reminders')).body.length !== 1) throw new Error('not cancelled');
  // Saving in another tab shows on Home by itself too.
  await api(page, 'PUT', `/chat/messages/${b}/saved`, { saved: true });
  await page.getByRole('region', { name: 'Saved in Chat' }).getByText('Check the stock count').waitFor();
  await page.screenshot({ path: `${SP}/shots/home-reminders.png` });
});
await step('Reminders in Chat: Home’s title opens them; open one, cancel one', async () => {
  const c = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'Renew the domain' })).body.id;
  await api(page, 'POST', `/chat/messages/${c}/remind`, { at: Date.now() + 2 * 864e5 });
  await page.goto(`${B}/home`);
  await page.getByRole('region', { name: 'Chat reminders' }).getByRole('link', { name: /Chat reminders/ }).click();
  await page.waitForURL('**/chat?reminders=1');
  await page.getByRole('heading', { name: 'Reminders', exact: true }).waitFor();
  const list = page.getByRole('list', { name: 'Reminders' });
  await until(async () => (await list.locator('li').count()) === 2);
  const rows = await list.locator('li').allInnerTexts();
  if (!/Check the stock count/.test(rows[0]) || !/Renew the domain/.test(rows[1]) || !/#general/.test(rows[0])) throw new Error(rows.join(' | '));
  await list.getByRole('button', { name: 'Cancel reminder: Renew the domain' }).click();
  await until(async () => (await list.locator('li').count()) === 1);
  await list.locator('.chat-result', { hasText: 'Check the stock count' }).click();
  await page.waitForURL(`**/chat/${general}**`);
  await page.locator('.msg', { hasText: 'Check the stock count' }).getByText(/I’ll remind you|I'll remind you/).waitFor();
});
await step('Note reminders on Home: soonest first, 🔁 on a repeating one; ✕ removes; the title opens Notes → Reminders', async () => {
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const a = (await api(page, 'POST', '/notes', { title: 'Water the plants' })).body;
  const b = (await api(page, 'POST', '/notes', { title: 'Pay the invoice' })).body;
  await api(page, 'PATCH', `/notes/${a.id}`, { remind_at: Date.now() + 2 * 864e5, remind_repeat: 'weekly', remind_tz: tz });
  await api(page, 'PATCH', `/notes/${b.id}`, { remind_at: Date.now() + 3600e3 });
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: 'Note reminders' });
  await card.waitFor();
  const rows = await card.locator('li').allInnerTexts();
  if (rows.length !== 2 || !/Pay the invoice/.test(rows[0]) || !/Water the plants/.test(rows[1]) || !/🔁/.test(rows[1])) throw new Error(rows.join(' | '));
  await card.getByRole('button', { name: 'Remove reminder: Pay the invoice' }).click();
  await until(async () => (await card.locator('li').count()) === 1);
  await card.getByRole('link', { name: /Note reminders/ }).click();
  await page.waitForURL('**/notes?reminders=1');
  await page.getByRole('article', { name: 'Water the plants' }).waitFor();
  if (await page.getByRole('article', { name: 'Pay the invoice' }).count()) throw new Error('not the Reminders list');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
