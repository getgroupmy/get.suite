import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const cell = (p, k) => p.locator(`.grid td[data-k="${k}"]`);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const typeIn = async (p, k, v) => { await cell(p, k).click(); await p.keyboard.type(v); await p.keyboard.press('Enter'); };
let id, kim, vic;

await step('setup: a spreadsheet shared with an editor and a viewer', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const local of ['kim', 'vic']) await api(page, 'POST', '/users', { local, domain: 'acme.com', name: local === 'kim' ? 'Kim Park' : 'Vic Viewer', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  id = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Item', B1: 'Cost' }, colWidths: {} }] } })).body.id;
  await api(page, 'PUT', `/files/${id}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'editor' }, { user_id: dir.find((u) => u.username === 'vic@acme.com').id, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/sheets/${id}`); await cell(p, 'A1').getByText('Item').waitFor(); }
});

await step('typing in different cells at once: both stay, formulas see them', async () => {
  await Promise.all([typeIn(page, 'A2', 'Bolts'), typeIn(kim, 'B2', '120')]);
  await typeIn(kim, 'B3', '=B2*2');
  for (const p of [page, kim, vic]) await until(async () => (await cell(p, 'A2').innerText()) === 'Bolts' && (await cell(p, 'B2').innerText()) === '120' && (await cell(p, 'B3').innerText()) === '240');
});

await step('formats and new sheets are shared too', async () => {
  await cell(page, 'A1').click();
  await page.keyboard.press('Control+b');
  await until(async () => (await cell(kim, 'A1').evaluate((el) => getComputedStyle(el).fontWeight)) === '700');
  await kim.getByRole('button', { name: 'Add sheet' }).click();
  await page.getByRole('button', { name: 'Sheet2', exact: true }).waitFor();
});

await step('you see who is here and which cell they are on', async () => {
  await kim.getByRole('button', { name: 'Sheet1', exact: true }).click(); // adding a sheet switched Kim to it
  await cell(kim, 'C5').click();
  await page.getByLabel(/^Also here: .*Kim Park/).waitFor();
  await until(async () => (await cell(page, 'C5').getAttribute('title')) === 'Kim Park is here');
  await page.screenshot({ path: `${SP}/shots/sheetcoedit.png` });
});

await step('it is saved; viewers watch but cannot edit', async () => {
  await until(async () => (await api(page, 'GET', `/files/${id}/content`)).body.content.sheets[0].cells.B3 === '=B2*2', 10000);
  await page.getByText('All changes saved').waitFor();
  await cell(vic, 'D1').click();
  await vic.keyboard.type('nope');
  await vic.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 1000));
  if ((await cell(page, 'D1').innerText()) !== '') throw new Error('a viewer changed a cell');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
