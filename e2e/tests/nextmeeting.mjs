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
await step('a meeting starting soon shows in the top bar with Join; one later, declined or all day doesn’t', async () => {
  const now = Date.now();
  await api(page, 'POST', '/events', { title: 'Later on', start: now + 60 * 60e3, end: now + 90 * 60e3 });
  await api(page, 'POST', '/events', { title: 'Holiday', start: now - 3600e3, end: now + 20 * 3600e3, all_day: true });
  await page.goto(`${B}/drive`);
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.waitForTimeout(1500);
  if (await page.locator('.next-meeting').count()) throw new Error('shown with nothing soon');
  const code = (await api(page, 'POST', '/meet', { title: 'Design review' })).body.code;
  const soon = (await api(page, 'POST', '/events', { title: 'Design review', start: now + 5 * 60e3 + 20e3, end: now + 35 * 60e3, meet_code: code })).body;
  if (soon.meet_code !== code) throw new Error(JSON.stringify(soon));
  const chip = page.getByRole('status', { name: /Design review in \d+ min/ });
  await chip.waitFor({ timeout: 10000 }); // the live update brings it
  await page.screenshot({ path: `${SP}/shots/nextmeeting.png` });
  {
    const join = chip.getByRole('link', { name: 'Join' });
    if ((await join.getAttribute('href')) !== `/meet/${soon.meet_code}`) throw new Error('join link');
  }
  await chip.getByRole('button', { name: /Design review/ }).click();
  await page.waitForURL(/\/calendar/);
  // Taken off (deleted): it goes.
  await api(page, 'DELETE', `/events/${soon.id}`);
  await chip.waitFor({ state: 'detached', timeout: 10000 });
});
await step('running late, said from the top bar: the others on the meeting are told', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const now = Date.now();
  const ev = (await api(page, 'POST', '/events', { title: 'Client call', start: now + 8 * 60e3, end: now + 38 * 60e3, guests: ['kim@acme.com'] })).body;
  const chip = page.getByRole('status', { name: /Client call in \d+ min/ });
  await page.goto(`${B}/drive`);
  await chip.waitFor({ timeout: 10000 });
  await chip.getByRole('button', { name: 'Running late' }).click();
  await page.getByRole('menuitem', { name: '10 minutes late' }).click();
  await page.getByText('Told the others you’re running 10 minutes late').waitFor();
  const late = (await api(page, 'GET', `/events/${ev.id}/late`)).body;
  if (!JSON.stringify(late).includes('10')) throw new Error(JSON.stringify(late));
  // Alone on a meeting: nobody to tell, so no ⏱.
  await api(page, 'DELETE', `/events/${ev.id}`);
  await api(page, 'POST', '/events', { title: 'Solo work', start: now + 3 * 60e3, end: now + 30 * 60e3 });
  const solo = page.getByRole('status', { name: /Solo work in \d+ min/ });
  await solo.waitFor({ timeout: 10000 });
  if (await solo.getByRole('button', { name: 'Running late' }).count()) throw new Error('running late shown with nobody to tell');
});
await step('meeting notes from the top bar: made for your meeting and opened in a new tab', async () => {
  const solo = page.getByRole('status', { name: /Solo work in \d+ min/ });
  await solo.waitFor({ timeout: 10000 });
  const [tab] = await Promise.all([page.context().waitForEvent('page'), solo.getByRole('button', { name: 'Take meeting notes' }).click()]);
  await tab.waitForURL(/\/docs\//, { timeout: 15000 });
  const id = new URL(tab.url()).pathname.split('/').pop();
  await tab.locator('.ProseMirror').getByText('Solo work').first().waitFor({ timeout: 15000 });
  await tab.close();
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const ev = ((await api(page, 'GET', `/events?from=${day.getTime() - 864e5}&to=${day.getTime() + 2 * 864e5}`)).body || []).find((e) => e.title === 'Solo work');
  if (ev?.notes_id !== id) throw new Error(`notes ${ev?.notes_id} vs ${id}`);
  await solo.getByRole('button', { name: 'Open meeting notes' }).waitFor(); // made: now it opens them
});
await step('× hides the meeting (also after reloading); the next one still shows', async () => {
  const now = Date.now();
  await api(page, 'POST', '/events', { title: 'Coffee chat', start: now + 13 * 60e3, end: now + 40 * 60e3 });
  const solo = page.getByRole('status', { name: /Solo work/ });
  await solo.waitFor({ timeout: 10000 });
  await solo.getByRole('button', { name: 'Hide this meeting here' }).click();
  const coffee = page.getByRole('status', { name: /Coffee chat in \d+ min/ });
  await coffee.waitFor(); // the next one
  await page.reload();
  await coffee.waitFor({ timeout: 10000 });
  if (await page.getByRole('status', { name: /Solo work/ }).count()) throw new Error('hidden meeting back after reloading');
});
await step('Calendar settings can turn the next meeting off in the top bar', async () => {
  await page.goto(`${B}/calendar`);
  const chip = page.locator('.next-meeting');
  await chip.waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /Calendar settings/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Calendar settings' });
  await dlg.getByLabel('Show my next meeting in the top bar').uncheck();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await chip.waitFor({ state: 'detached' });
  await page.reload();
  await page.waitForTimeout(1500);
  if (await chip.count()) throw new Error('shown again after reloading');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
