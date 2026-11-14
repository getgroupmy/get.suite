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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
let sheet;
const sheetNow = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].cells;
const dragHandleTo = async (k) => {
  const h = page.locator('.fill-handle');
  await h.waitFor();
  const a = await h.boundingBox(), b = await cell(k).boundingBox();
  await page.mouse.move(a.x + 4, a.y + 4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
};
await step('drag the fill handle: numbers, items, months and formulas carry on', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Fill', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: '1', A2: '2', B1: 'Item 1', B2: 'Item 2', C1: 'Jan', C2: 'Feb', D1: '=A1*10', D2: '=A2*10' } }] } })).body;
  await api(page, 'PUT', `/files/${sheet.id}/content`, { version: 1, content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: '1', A2: '2', B1: 'Item 1', B2: 'Item 2', C1: 'Jan', C2: 'Feb', D1: '=A1*10', D2: '=A2*10' }, formats: { B1: { b: true } } }] } });
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A1').click();
  await cell('D2').click({ modifiers: ['Shift'] });
  await dragHandleTo('D5');
  await until(async () => { const c = await sheetNow(); return c.A5 === '5' && c.B5 === 'Item 5' && c.C5 === 'May' && c.D5 === '=A5*10'; });
  await until(async () => (await cell('D5').innerText()).trim() === '50');
  const f = (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].formats || {};
  if (!f.B3?.b || !f.B5?.b || f.B4) throw new Error('formats ' + JSON.stringify(f));
});
await step('the selection shows its sum, average and count', async () => {
  await cell('A1').click();
  await cell('A5').click({ modifiers: ['Shift'] });
  const st = page.getByRole('status', { name: 'Selection' });
  await st.getByText('Sum:').waitFor();
  const t = await st.innerText();
  if (!/Sum: 15/.test(t) || !/Average: 3/.test(t) || !/Count: 5/.test(t)) throw new Error(t);
  await cell('B1').click();
  if (await st.count()) throw new Error('shown for one cell');
});
await step('Ctrl+D fills down and Ctrl+R fills right', async () => {
  await cell('F1').click(); await page.keyboard.type('x'); await page.keyboard.press('Enter');
  await cell('F1').click();
  await cell('F3').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+d');
  await until(async () => { const c = await sheetNow(); return c.F2 === 'x' && c.F3 === 'x'; });
  await cell('G1').click();
  await page.keyboard.press('Control+r');
  await until(async () => (await sheetNow()).G1 === 'x');
});
await step('dropping the handle back on the selection changes nothing', async () => {
  await cell('C1').click();
  await dragHandleTo('C1'); // no change: dropped on itself
  await page.waitForTimeout(300);
  if ((await sheetNow()).B1 !== 'Item 1') throw new Error('changed');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
