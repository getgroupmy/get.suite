import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
let ev, notes, kim;
await step('take meeting notes from an event: a document opens with the details', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const start = Math.ceil(Date.now() / 36e5) * 36e5 + 36e5;
  ev = (await api(page, 'POST', '/events', { title: 'Budget review', start, end: start + 36e5, location: 'Room 4', description: 'Q3 figures\nHiring plan', guests: ['kim@acme.com'] })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Budget review', { exact: true }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  const [tab] = await Promise.all([page.waitForEvent('popup'), dlg.getByRole('button', { name: /Take meeting notes/ }).click()]);
  await tab.waitForURL(/\/docs\//);
  notes = tab.url().split('/docs/')[1];
  const ed = tab.locator('.ProseMirror');
  await ed.getByRole('heading', { name: 'Budget review' }).waitFor();
  await ed.getByText('Room 4').waitFor();
  await ed.getByText('@Kim Park').waitFor();
  await ed.getByText('Hiring plan').waitFor();
  await ed.getByRole('heading', { name: 'Action items' }).waitFor();
  await dlg.getByRole('list', { name: 'Attachments' }).getByRole('link', { name: /^Notes – Budget review/ }).waitFor();
  await dlg.getByRole('button', { name: /Open meeting notes/ }).waitFor();
  await tab.close();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  const evs = (await api(page, 'GET', `/events?from=${start - 864e5}&to=${start + 864e5}`)).body;
  const saved = evs.find((e) => e.id === ev.id);
  if (!saved.attachments.some((a) => a.id === notes) || saved.notes_id !== notes) throw new Error(JSON.stringify(saved.attachments));
});
await step('the guest finds the notes on the invitation and can write in them', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('radio', { name: 'Schedule' }).click();
  await kim.getByText('Budget review', { exact: true }).first().click();
  const link = kim.getByRole('dialog', { name: 'Budget review' }).getByRole('list', { name: 'Attachments' }).getByRole('link', { name: /^Notes – Budget review/ });
  if ((await link.getAttribute('href')) !== `/docs/${notes}`) throw new Error('href');
  await kim.goto(`${B}/docs/${notes}`);
  const ed = kim.locator('.ProseMirror');
  await ed.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
  if ((await ed.getAttribute('contenteditable')) !== 'true') throw new Error('read only for the guest');
  await ed.getByRole('heading', { name: 'Notes', exact: true }).click();
  await kim.keyboard.press('End');
  await kim.keyboard.press('Enter');
  await kim.keyboard.type('Kim agreed to send the figures');
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${notes}/content`)).body.content).includes('Kim agreed'), 10000);
}, kim);
await step('asking again opens the same notes', async () => {
  const r = await api(page, 'POST', `/events/${ev.id}/notes`, {});
  if (r.status !== 200 || r.body.id !== notes) throw new Error(JSON.stringify(r));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
