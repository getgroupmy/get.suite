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
const pad = (n) => String(n).padStart(2, '0');
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
let general;
const box = () => page.getByLabel('Message', { exact: true });
const mark = () => page.locator('.paused-mark');
const paused = async () => (await api(page, 'GET', '/users/me/pause')).body.paused_until;
await step('/dnd alone pauses for an hour; the 🔕 shows; nothing is posted', async () => {
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await box().fill('/d');
  const list = page.getByRole('listbox', { name: 'Commands' });
  if ((await list.getByRole('option').count()) !== 1) throw new Error('not narrowed');
  await box().fill('/dnd');
  const before = Date.now();
  await box().press('Enter');
  await page.getByText(/^Notifications paused until /).waitFor();
  await mark().waitFor();
  const p = await paused();
  if (Math.abs(p - before - 3600e3) > 60e3) throw new Error(String(p - before));
  if (await box().inputValue() !== '') throw new Error('not cleared');
  if (await page.locator('.messages').getByText('/dnd').count()) throw new Error('posted');
});
await step('/dnd tomorrow: until 9:00 tomorrow; /dnd off turns them back on', async () => {
  await box().fill('/dnd tomorrow');
  await box().press('Enter');
  await until(async () => { const p = await paused(); const d = p && new Date(p); return d && d.getHours() === 9 && d.getMinutes() === 0 && d.getDate() !== new Date().getDate(); });
  await box().fill('/dnd off');
  await box().press('Enter');
  await page.getByText('Notifications are back on').waitFor();
  await mark().waitFor({ state: 'detached' });
  if (await paused()) throw new Error('still paused');
});
await step('/dnd in a thread, for 45 minutes', async () => {
  const top = (await api(page, 'POST', `/chat/channels/${general}/messages`, { body: 'Quiet please' })).body;
  const m = page.locator(`[data-mid="${top.id}"]`);
  await m.waitFor(); await m.hover();
  await m.getByRole('button', { name: 'Reply in thread' }).click();
  const reply = page.getByRole('complementary', { name: 'Thread' }).getByLabel('Reply', { exact: true });
  await reply.fill('/dnd for 45 minutes');
  await reply.press('Enter');
  await mark().waitFor();
  if (Math.abs((await paused()) - Date.now() - 45 * 60e3) > 60e3) throw new Error('not 45m');
  await mark().click(); // the 🔕 resumes
  await mark().waitFor({ state: 'detached' });
});
await step('a bad /dnd: an error, the text stays', async () => {
  await box().fill('/dnd forever');
  await box().press('Enter');
  await page.getByText('Write it as /dnd 30m, /dnd 2h, /dnd tomorrow or /dnd off').waitFor();
  if (await box().inputValue() !== '/dnd forever') throw new Error(await box().inputValue());
  if (await paused()) throw new Error('paused');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
