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
const mineTitles = async () => (await api(page, 'GET', '/forms')).body.filter((f) => !f.archived_at).map((f) => `${f.title}${f.closed ? ' (closed)' : ''}`).sort();
await step('Select: stop and start accepting responses for several forms at once', async () => {
  for (const title of ['Lunch order', 'Team offsite', 'Old survey']) await api(page, 'POST', '/forms', { title });
  await page.goto(`${B}/forms`);
  await page.getByRole('list', { name: 'Your forms' }).getByText('Old survey').waitFor();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const bar = page.getByRole('toolbar', { name: 'Change the selected forms' });
  await page.getByLabel('Select: Lunch order').check();
  await page.getByLabel('Select: Old survey').check();
  await bar.getByText('2 selected').waitFor();
  await bar.getByRole('button', { name: 'Stop accepting' }).click();
  await page.locator('.toast', { hasText: '2 forms no longer accepting responses' }).last().waitFor();
  let t = await mineTitles();
  if (t.join('|') !== 'Lunch order (closed)|Old survey (closed)|Team offsite') throw new Error(t.join('|'));
  await page.getByRole('list', { name: 'Your forms' }).locator('li', { hasText: 'Lunch order' }).getByText('Closed').waitFor();
  await page.getByLabel('Select: Lunch order').check();
  await bar.getByRole('button', { name: 'Accept again' }).click();
  await page.locator('.toast', { hasText: '1 form accepting responses again' }).last().waitFor();
  t = await mineTitles();
  if (t.join('|') !== 'Lunch order|Old survey (closed)|Team offsite') throw new Error(t.join('|'));
});
await step('Select all shown, delete them after a confirmation, and Undo brings them back', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected forms' });
  await page.getByLabel('Search your forms').fill('o');
  await bar.getByRole('button', { name: 'Select all shown' }).click();
  await bar.getByText('3 selected').waitFor();
  await page.getByLabel('Select: Team offsite').uncheck();
  await bar.getByRole('button', { name: 'Delete' }).click();
  const dlg = page.getByRole('dialog', { name: 'Delete 2 forms?' });
  await dlg.getByRole('button', { name: 'Delete' }).click();
  const toast = page.locator('.toast', { hasText: '2 forms deleted' }).last();
  await toast.waitFor();
  if ((await mineTitles()).join('|') !== 'Team offsite') throw new Error((await mineTitles()).join('|'));
  await toast.getByRole('button', { name: 'Undo' }).click();
  await until(async () => (await mineTitles()).length === 3);
  await page.getByRole('list', { name: 'Your forms' }).getByText('Lunch order').waitFor();
});
await step('Archive several, then bring them back from Archived', async () => {
  await page.getByLabel('Search your forms').fill('');
  const bar = page.getByRole('toolbar', { name: 'Change the selected forms' });
  await page.getByLabel('Select: Lunch order').check();
  await page.getByLabel('Select: Old survey').check();
  await bar.getByRole('button', { name: 'Archive' }).click();
  await page.locator('.toast', { hasText: '2 forms archived' }).last().waitFor();
  const arch = async () => (await api(page, 'GET', '/forms')).body.filter((f) => f.archived_at).map((f) => f.title).sort().join('|');
  if (await arch() !== 'Lunch order|Old survey') throw new Error(await arch());
  await page.getByRole('list', { name: 'Your forms' }).getByText('Lunch order').waitFor({ state: 'detached' });
  await page.getByLabel('Show').selectOption('archived');
  await page.getByLabel('Select: Lunch order').check();
  await page.getByLabel('Select: Old survey').check();
  await bar.getByRole('button', { name: 'Bring back' }).click();
  await page.locator('.toast', { hasText: '2 forms brought back from the archive' }).last().waitFor();
  if (await arch() !== '') throw new Error(await arch());
  await page.getByLabel('Show').selectOption('all');
  await page.getByRole('list', { name: 'Your forms' }).getByText('Lunch order').waitFor();
});
await step('Make copies of several forms at once', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected forms' });
  await page.getByLabel('Select: Lunch order').check();
  await page.getByLabel('Select: Team offsite').check();
  await bar.getByRole('button', { name: 'Make copies' }).click();
  await page.locator('.toast', { hasText: '2 copies made' }).last().waitFor();
  await page.getByRole('list', { name: 'Your forms' }).getByText('Copy of Lunch order').waitFor();
  await page.getByRole('list', { name: 'Your forms' }).getByText('Copy of Team offsite').waitFor();
  for (const f of (await api(page, 'GET', '/forms')).body.filter((x) => x.title.startsWith('Copy of'))) await api(page, 'DELETE', `/forms/${f.id}`);
  await page.getByRole('list', { name: 'Your forms' }).getByText('Copy of Lunch order').waitFor({ state: 'detached' });
});
await step('Download responses: the picked forms\' responses as CSV files in one .zip', async () => {
  const lunch = (await api(page, 'GET', '/forms')).body.find((f) => f.title === 'Lunch order');
  await api(page, 'PUT', `/forms/${lunch.id}`, { questions: [{ id: 'q', type: 'short', title: 'Dish' }] });
  const tok = (await api(page, 'GET', `/forms/${lunch.id}`)).body.token;
  await api(page, 'POST', `/public/forms/${tok}`, { answers: { q: 'Noodles' } });
  const bar = page.getByRole('toolbar', { name: 'Change the selected forms' });
  await page.getByLabel('Select: Lunch order').check();
  await page.getByLabel('Select: Team offsite').check();
  const [dl] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download responses' }).click()]);
  if (dl.suggestedFilename() !== 'form responses.zip') throw new Error(dl.suggestedFilename());
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(await dl.path()));
  const names = Object.keys(zip.files).sort().join('|');
  if (names !== 'Lunch order responses.csv|Team offsite responses.csv') throw new Error(names);
  if (!/Noodles/.test(await zip.file('Lunch order responses.csv').async('string'))) throw new Error('no answer');
  await page.getByLabel('Select: Lunch order').uncheck();
  await page.getByLabel('Select: Team offsite').uncheck();
});
await step('Delete is off when a form shared with you is selected', async () => {
  const sam = (await api(page, 'POST', '/users', { local: 'sam', domain: 'acme.com', name: 'Sam Shared', password: 'password123' })).body;
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await signIn(p2, 'sam@acme.com');
  const theirs = (await api(p2, 'POST', '/forms', { title: 'Sam poll' })).body;
  await api(p2, 'POST', `/forms/${theirs.id}/editors`, { email: 'olivia@acme.com' });
  await ctx.close();
  if (!sam?.id) throw new Error('no Sam');
  await page.reload();
  await page.getByRole('list', { name: 'Your forms' }).getByText('Sam poll').waitFor();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByLabel('Select: Sam poll').check();
  const bar = page.getByRole('toolbar', { name: 'Change the selected forms' });
  if (!(await bar.getByRole('button', { name: 'Delete' }).isDisabled())) throw new Error('Delete on for someone else\'s form');
  await bar.getByRole('button', { name: 'Stop accepting' }).click();
  await page.locator('.toast', { hasText: '1 form no longer accepting responses' }).last().waitFor();
});
await step('Add editor…: a colleague can edit several of your forms at once', async () => {
  await page.reload();
  await page.getByRole('list', { name: 'Your forms' }).getByText('Lunch order').waitFor();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByLabel('Select: Lunch order').check();
  await page.getByLabel('Select: Team offsite').check();
  const bar = page.getByRole('toolbar', { name: 'Change the selected forms' });
  await bar.getByRole('button', { name: 'Add editor…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Add an editor to 2 forms' });
  await dlg.getByLabel('Colleague').fill('sam@acme.com');
  await dlg.getByLabel('Message (optional)').fill('Can you check these?');
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('.toast', { hasText: 'Sam Shared can now edit 2 forms' }).last().waitFor();
  const all = (await api(page, 'GET', '/forms')).body;
  for (const t of ['Lunch order', 'Team offsite']) {
    const f = (await api(page, 'GET', `/forms/${all.find((x) => x.title === t).id}`)).body;
    if (f.editors.map((e) => e.name).join() !== 'Sam Shared') throw new Error(`${t}: ${JSON.stringify(f.editors)}`);
  }
  const old = (await api(page, 'GET', `/forms/${all.find((x) => x.title === 'Old survey').id}`)).body;
  if (old.editors.length) throw new Error('Old survey changed');
  // With someone else's form among those picked, it's off.
  await page.getByLabel('Select: Sam poll').check();
  if (!(await bar.getByRole('button', { name: 'Add editor…' }).isDisabled())) throw new Error('on for a form shared with you');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
