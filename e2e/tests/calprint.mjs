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
await step('Sheets ⋮ → Add rows to Tasks…: each row a task in the list you pick', async () => {
  const list = (await api(page, "POST", "/tasks/lists", { name: "Launch prep" })).body.id;
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Todo', content: { sheets: [{ name: 'Sheet1', cells: {
    A1: 'Title', B1: 'Notes', A2: 'Book the venue', B2: 'Ask for the big room', A3: 'Order badges' } }] } })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.locator('[data-k="A2"]', { hasText: 'Book the venue' }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Add rows to Tasks…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add rows to Tasks' });
  await dlg.getByLabel('List').selectOption({ label: 'Launch prep' });
  await dlg.getByRole('button', { name: 'Add tasks' }).click();
  await page.getByText('Added 2 tasks to Launch prep').waitFor();
  await page.getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(new RegExp(`/tasks/${list}`));
  await page.getByText('Order badges').first().waitFor();
  const got = (await api(page, 'GET', `/tasks/lists/${list}/tasks`)).body;
  const ts = Array.isArray(got) ? got : got.tasks || [];
  const venue = ts.find((x) => x.title === 'Book the venue');
  if (!venue || venue.notes !== 'Ask for the big room' || !ts.some((x) => x.title === 'Order badges')) throw new Error(JSON.stringify(got).slice(0, 400));
});
await step('Sheets ⋮ → Add rows to Contacts: a sheet of names and emails becomes contacts, not twice', async () => {
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Suppliers', content: { sheets: [{ name: 'Sheet1', cells: {
    A1: 'Name', B1: 'Email', C1: 'Company', A2: 'Rhea Rowe', B2: 'rhea@supply.example', C2: 'Rowe Paper' } }] } })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.locator('[data-k="A2"]', { hasText: 'Rhea Rowe' }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Add rows to Contacts' }).click();
  await page.getByText('Added 1 contact').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Add rows to Contacts' }).click();
  await page.getByText('Everyone on this sheet is already in your contacts').waitFor();
  await page.getByRole('button', { name: 'Open Contacts' }).last().click();
  await page.waitForURL(/\/contacts/);
  await page.getByText('Rhea Rowe').first().waitFor();
});
await step('Sheets ⋮ → Make a contact group…: the sheet’s names and emails in a group named as typed', async () => {
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Choir', content: { sheets: [{ name: 'Sheet1', cells: {
    A1: 'Name', B1: 'Email', A2: 'Alto Ash', B2: 'alto@choir.example', A3: 'Bass Birch', B3: 'bass@choir.example' } }] } })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.locator('[data-k="A2"]', { hasText: 'Alto Ash' }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Make a contact group…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Make a contact group' });
  if ((await dlg.getByLabel('Group name').inputValue()) !== 'Choir') throw new Error('not named after the spreadsheet');
  await dlg.getByLabel('Group name').fill('Choir 2027');
  await dlg.getByRole('button', { name: 'Make group' }).click();
  await page.getByText('Made the group “Choir 2027” (2 people)').waitFor();
  const g = (await api(page, 'GET', '/contacts/groups')).body.find((x) => x.name === 'Choir 2027');
  if (!g || g.members.map((m) => m.email).join() !== 'alto@choir.example,bass@choir.example') throw new Error(JSON.stringify(g));
});
await step('Sheets ⋮ → Copy to a new document: the sheet as a table, worked-out values, heading row', async () => {
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', cells: {
    A1: 'Item', B1: 'Cost', A2: 'Venue', B2: '800', A3: 'Food', B3: '450', A4: 'Total', B4: '=SUM(B2:B3)' } }] } })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.locator('[data-k="A2"]', { hasText: 'Venue' }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy to a new document' }).click();
  await page.getByText('Made “Budget (table)” in your Drive (A1:B4)').waitFor();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/docs\//);
  const ed = page.locator('.paper .tiptap');
  await ed.locator('h1', { hasText: 'Budget' }).waitFor();
  await ed.locator('th', { hasText: 'Cost' }).waitFor();
  await ed.locator('td', { hasText: '1250' }).waitFor();
});
await step('Sheets ⋮ → Copy to a new presentation: the selected cells as a table on a slide', async () => {
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Results', content: { sheets: [{ name: 'Sheet1', cells: {
    A1: 'Team', B1: 'Score', C1: 'Note', A2: 'Reds', B2: '12', C2: 'x', A3: 'Blues', B3: '=B2+3', C3: 'y' } }] } })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.locator('[data-k="A1"]', { hasText: 'Team' }).click();
  await page.locator('[data-k="B3"]').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Copy to a new presentation' }).click();
  await page.getByText('Made “Results (slides)” in your Drive (A1:B3)').waitFor();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(/\/slides\//);
  // (the spreadsheet can stay on screen a moment while Slides loads: wait for its cells to go before reading the slide)
  await page.locator('[data-k="A1"]').waitFor({ state: 'detached' });
  await page.getByText('Blues').first().waitFor();
  await page.getByText('15', { exact: true }).first().waitFor();
  if (await page.getByText('Note', { exact: true }).count()) throw new Error('only the selected columns');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
