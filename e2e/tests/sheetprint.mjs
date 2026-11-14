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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
let sheet;

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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Quote', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Item', B1: 'Price', C1: 'Cost', A2: 'Bolts', B2: '1.5', C2: 'x', A3: 'Nuts', B3: '2', A4: 'Total', B4: '=B2+B3' }, formats: { A1: { b: true }, A4: { bd: 't' } }, hide: { cols: [2] } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
  // Printing happens in a frame; keep the dialog from opening in the test browser.
  await page.addInitScript(() => {});
  await page.evaluate(() => { const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow'); Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { get() { const w = d.get.call(this); if (w) w.print = () => { window.__printed = (window.__printed || 0) + 1; }; return w; } }); });
});
await step('print the whole sheet: values as shown, bold kept, the hidden column left out', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Print or save as PDF' }).click();
  const d = page.getByRole('dialog', { name: 'Print or save as PDF' });
  await d.getByLabel('This sheet').check();
  await d.getByLabel('Orientation').selectOption('landscape');
  await d.getByRole('button', { name: 'Print' }).click();
  const frame = page.frameLocator('iframe.print-frame');
  await frame.getByRole('cell', { name: '3.5' }).waitFor();
  await frame.locator('td', { hasText: /^Item$/ }).and(frame.locator('td[style*="font-weight"]')).waitFor();
  if (await frame.getByText('Cost').count()) throw new Error('hidden column printed');
  const html = await page.locator('iframe.print-frame').getAttribute('srcdoc');
  if (!/size:A4 landscape/.test(html)) throw new Error('orientation');
  if (!/border-top:1px solid var\(--cell-border, #202124\)">Total/.test(html)) throw new Error('border ' + html.slice(html.indexOf('Total') - 120, html.indexOf('Total') + 5));
  await until(() => page.evaluate(() => window.__printed === 1));
});
await step('print just the selected cells', async () => {
  await page.evaluate(() => document.querySelectorAll('iframe.print-frame').forEach((f) => f.remove()));
  await cell('A2').click();
  await cell('B3').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Print or save as PDF' }).click();
  const d = page.getByRole('dialog', { name: 'Print or save as PDF' });
  if (!(await d.getByLabel('Selected cells').isChecked())) throw new Error('selection not the default');
  await d.getByRole('button', { name: 'Print' }).click();
  const frame = page.frameLocator('iframe.print-frame');
  await frame.getByRole('cell', { name: 'Nuts' }).waitFor();
  if (await frame.getByText('Item').count() || await frame.getByText('Total').count()) throw new Error('more than the selection');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
