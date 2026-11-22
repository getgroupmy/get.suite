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
await step('two events this week, one next month', async () => {
  const d = new Date(); const at = (days, h) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h).getTime();
  await api(page, 'POST', '/events', { title: 'Board meeting', location: 'Room 4', start: at(0, 10), end: at(0, 11) });
  await api(page, 'POST', '/events', { title: 'Team lunch', start: at(0, 12), end: at(0, 13) });
  await api(page, 'POST', '/events', { title: 'Far away', start: at(40, 9), end: at(40, 10) });
});
await step('Print or save as PDF shows this week as an agenda', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Print or save as PDF' }).click();
  const d = page.getByRole('dialog', { name: 'Print or save as PDF' });
  const prev = d.locator('.agenda-preview');
  await prev.getByText('Board meeting').waitFor();
  await prev.getByText('· Room 4').waitFor();
  await prev.getByText('Team lunch').waitFor();
  if (await prev.getByText('Far away').count()) throw new Error('not this week');
  await d.getByLabel('What to print').selectOption('custom');
  const t = new Date(Date.now() + 40 * 864e5); const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  await d.getByLabel('From', { exact: true }).fill(iso); await d.getByLabel('To', { exact: true }).fill(iso);
  await prev.getByText('Far away').waitFor();
  await d.getByLabel('What to print').selectOption('week');
  await prev.getByText('Board meeting').waitFor();
});
await step('printing shows only the agenda', async () => {
  await page.evaluate(() => { window.print = () => { window.__printing = document.body.classList.contains('printing-agenda'); }; });
  await page.getByRole('dialog', { name: 'Print or save as PDF' }).getByRole('button', { name: 'Print' }).click();
  if (!(await page.evaluate(() => window.__printing))) throw new Error('print mode not set');
  await page.evaluate(() => document.body.classList.add('printing-agenda'));
  await page.emulateMedia({ media: 'print' });
  const visible = await page.evaluate(() => [...document.body.children].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.className));
  if (visible.join() !== 'print-agenda-root') throw new Error('visible: [' + visible.join('|') + ']');
  const text = await page.evaluate(() => document.querySelector('.print-agenda-root').innerText);
  if (!text.includes('Board meeting') || !text.includes('Room 4')) throw new Error(text);
  await page.emulateMedia({ media: 'screen' });
});
await step('Copy to a document: the agenda as a document, a heading a day and a table of times and events', async () => {
  await page.evaluate(() => document.body.classList.remove('printing-agenda'));
  await page.getByRole('dialog', { name: 'Print or save as PDF' }).getByRole('button', { name: 'Copy to a document' }).click();
  await page.waitForURL(/\/docs\//);
  const ed = page.locator('.paper .tiptap');
  await ed.locator('h1').first().waitFor();
  const row = ed.locator('tr', { hasText: 'Board meeting' });
  await row.getByText('· Room 4').waitFor();
  await row.locator('strong', { hasText: 'Board meeting' }).waitFor();
  await ed.locator('tr', { hasText: 'Team lunch' }).waitFor();
  if (await ed.getByText('Far away').count()) throw new Error('only this week');
  if (!(await ed.locator('h2').count())) throw new Error('a heading a day');
});
await step('Open in Sheets: the agenda a row an event, with its hours', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Print or save as PDF' }).click();
  const d = page.getByRole('dialog', { name: 'Print or save as PDF' });
  await d.locator('.agenda-preview').getByText('Board meeting').waitFor();
  await d.getByRole('button', { name: 'Open in Sheets' }).click();
  await page.waitForURL(/\/sheets\//);
  await page.locator('[data-k="E1"]', { hasText: 'What' }).waitFor();
  const id = page.url().split('/').pop().split('?')[0];
  const cells = (await api(page, 'GET', `/files/${id}/content`)).body.content.sheets[0].cells;
  const row = Object.keys(cells).find((k) => cells[k] === 'Board meeting')?.replace(/^[A-Z]+/, '');
  if (!row || cells[`D${row}`] !== '1' || cells[`F${row}`] !== 'Room 4' || !/^\d\d:\d\d$/.test(cells[`B${row}`])) throw new Error(JSON.stringify(cells));
  if (Object.values(cells).includes('Far away')) throw new Error('only this week');
});
await step('Sheets ⋮ → Add events to Calendar: a sheet laid out as a calendar’s CSV, its rows on the calendar', async () => {
  const t = new Date(); const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Plan', content: { sheets: [{ name: 'Sheet1', cells: {
    A1: 'Subject', B1: 'Start Date', C1: 'Start Time', D1: 'End Date', E1: 'End Time', A2: 'Sprint planning', B2: day, C2: '09:00', D2: day, E2: '09:45' } }] } })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.locator('[data-k="A2"]', { hasText: 'Sprint planning' }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Add events to Calendar' }).click();
  await page.getByText('Added 1 event to your calendar').waitFor();
  await page.getByRole('button', { name: 'Open Calendar' }).click();
  await page.waitForURL(/\/calendar/);
  await page.getByText('Sprint planning').first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
