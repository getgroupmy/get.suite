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

const names = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo'];
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
  const cells = { A1: 'Name', B1: 'Score' };
  names.forEach((n, i) => { cells[`A${i + 2}`] = n; cells[`B${i + 2}`] = String((i + 1) * 10); });
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Draw', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
const now = async () => (await api(page, 'GET', `/files/${sheet.id}/content`)).body.content.sheets[0].cells;
await step('Randomise rows shuffles the rows (each name keeps its score); the header stays', async () => {
  let shuffled = false;
  for (let attempt = 0; attempt < 3 && !shuffled; attempt++) {
    await cell('A2').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Randomise rows' }).click();
    await page.getByText(/Shuffled 10 rows \(the header stays\)/).last().waitFor();
    let c;
    await until(async () => { c = await now(); return names.map((_, i) => c[`A${i + 2}`]).join() !== names.join(); }, 6000).catch(() => {});
    if (c.A1 !== 'Name' || c.B1 !== 'Score') throw new Error('header moved');
    const rows = names.map((_, i) => [c[`A${i + 2}`], c[`B${i + 2}`]]);
    if (rows.map((r) => r[0]).sort().join() !== [...names].sort().join()) throw new Error(JSON.stringify(rows));
    for (const [n, s] of rows) if (s !== String((names.indexOf(n) + 1) * 10)) throw new Error(`${n} lost its score`);
    shuffled = rows.map((r) => r[0]).join() !== names.join();
  }
  if (!shuffled) throw new Error('never shuffled');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
