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
let kim;
const events = (p) => api(p, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 30 * 864e5}`).then((r) => r.body);

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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});

await step('a new event reminds you 10 minutes before; you can add and change reminders', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Week' }).click();
  const col = page.locator('.tg-col.today');
  await page.locator('.tg-scroll').evaluate((el) => { el.scrollTop = 13 * 48; });
  const box = await col.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 15 * 48 + 10);
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.waitFor();
  if (await dlg.getByLabel('Reminder 1', { exact: true }).inputValue() !== '10') throw new Error('no default reminder');
  await dlg.getByRole('button', { name: 'Add another reminder' }).click();
  await dlg.getByLabel('Reminder 2', { exact: true }).selectOption({ label: '1 day before' });
  await dlg.getByLabel('Title').fill('Planning');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => JSON.stringify((await events(page)).find((e) => e.title === 'Planning')?.reminders) === '[10,1440]');
  await page.locator('.tg-event', { hasText: 'Planning' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit event' });
  await edit.getByRole('button', { name: 'Remove reminder 10 minutes before' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await until(async () => JSON.stringify((await events(page)).find((e) => e.title === 'Planning')?.reminders) === '[1440]');
});

await step('when a reminder is due, it shows once (not in every tab)', async () => {
  const second = await page.context().newPage(); // another tab, signed in as the same person
  await second.goto(`${B}/drive`);
  await page.goto(`${B}/drive`);
  await page.waitForTimeout(1000);
  const start = Date.now() + 70e3; // a reminder 1 minute before: due in about 10 seconds
  await api(page, 'POST', '/events', { title: 'Supplier call', start, end: start + 30 * 6e4, reminders: [1], location: 'Room 2' });
  const shown = async () => (await page.getByText('Supplier call starts in 1 minute · Room 2').count()) + (await second.getByText('Supplier call starts in 1 minute · Room 2').count());
  await until(async () => (await shown()) >= 1, 30000);
  await page.waitForTimeout(1500);
  if (await shown() !== 1) throw new Error(`shown ${await shown()} times`);
  await page.screenshot({ path: `${SP}/shots/reminder.png` });
  await second.close();
});

await step('a guest sets their own reminder on an invitation', async () => {
  const start = Date.now() + 3 * 864e5;
  const ev = (await api(page, 'POST', '/events', { title: 'Offsite', start, end: start + 36e5, reminders: [30], guests: ['kim@acme.com'] })).body;
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('radio', { name: 'Month' }).click();
  for (let i = 0; i < 2 && !(await kim.getByText('Offsite').count()); i++) await kim.getByRole('button', { name: /^Next/ }).click();
  await kim.getByText('Offsite').first().click();
  const dlg = kim.getByRole('dialog', { name: 'Offsite' });
  await dlg.getByRole('button', { name: 'Add a reminder' }).click();
  await until(async () => JSON.stringify((await events(kim)).find((e) => e.id === ev.id)?.reminders) === '[10]');
  if (JSON.stringify((await events(page)).find((e) => e.id === ev.id).reminders) !== '[30]') throw new Error("the organiser's changed");
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
