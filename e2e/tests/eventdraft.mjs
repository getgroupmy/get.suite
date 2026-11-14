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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
let doc;
const draft = () => page.locator('.ProseMirror .doc-event');
const pad = (n) => String(n).padStart(2, '0');
const t = new Date(); const day = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 2);
const iso = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
await step('@event puts in an event draft (today); its title, day, times, guests and notes are written in the document', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('@meet');
  await page.getByRole('listbox', { name: 'People, dates and files' }).getByRole('option', { name: /Event draft/ }).click();
  await draft().waitFor();
  if (await draft().getByLabel('Day').inputValue() !== `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`) throw new Error('not today');
  await page.keyboard.type('Agenda: scope and dates.');
  await draft().getByLabel('Title').fill('Launch kickoff');
  await draft().getByLabel('Day').fill(iso);
  await draft().getByLabel('Starts').fill('10:00');
  await draft().getByLabel('Ends').fill('11:30');
  await draft().getByLabel('Guests').fill('kim@acme.com');
  await draft().getByLabel('Where').fill('Room 4');
  await page.screenshot({ path: `${SP}/shots/eventdraft-doc.png` });
  await page.waitForTimeout(1500);
  await page.reload();
  await draft().waitFor();
  if (await draft().getByLabel('Starts').inputValue() !== '10:00' || await draft().getByLabel('Title').inputValue() !== 'Launch kickoff') throw new Error('not kept');
  await draft().locator('.doc-email-body', { hasText: 'Agenda: scope and dates.' }).waitFor();
});
await step('Add to Calendar opens it as a new event to check: day, times, guest, place, notes and the document attached', async () => {
  const [cal] = await Promise.all([page.context().waitForEvent('page'), draft().getByRole('button', { name: 'Add to Calendar' }).click()]);
  const d = cal.getByRole('dialog', { name: 'New event' });
  await d.waitFor({ timeout: 30000 });
  const val = (l, o) => d.getByLabel(l, o).first().inputValue();
  if (await val('Title') !== 'Launch kickoff') throw new Error('title');
  if (await d.locator('input[type="date"]').first().inputValue() !== iso) throw new Error('day');
  if (await d.locator('input[type="time"]').first().inputValue() !== '10:00' || await d.getByLabel('End time').inputValue() !== '11:30') throw new Error('times');
  await d.getByText('kim@acme.com').first().waitFor().catch(async () => { await d.getByText('Kim Park').first().waitFor(); });
  await d.getByText('Launch plan').first().waitFor();
  if (!(await d.locator('textarea').first().inputValue()).includes(`/docs/${doc.id}`)) throw new Error('no link to the document');
  await cal.screenshot({ path: `${SP}/shots/eventdraft-calendar.png` });
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await d.waitFor({ state: 'detached' });
  await cal.close();
});
await step('Kim is invited and can open the document from it', async () => {
  const kctx = await browser.newContext(); const k = await kctx.newPage();
  await k.goto(B); await k.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  const ev = await until(async () => ((await api(k, 'GET', '/events')).body || []).find((e) => e.title === 'Launch kickoff'));
  if (ev.location !== 'Room 4' || ev.all_day) throw new Error(JSON.stringify(ev).slice(0, 200));
  if (!ev.attachments.some((a) => a.id === doc.id)) throw new Error('no document attached');
  if ((await api(k, 'GET', `/files/${doc.id}`)).status !== 200) throw new Error('Kim cannot open the document');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
