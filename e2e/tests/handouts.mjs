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
const { execFileSync } = await import('node:child_process');
const fs = await import('node:fs');
let deck;
const slidesOf = () => Array.from({ length: 7 }, (_, i) => ({ id: `s${i + 1}`, ...(i === 3 && { skip: true }), notes: `Notes for slide ${i + 1}`, items: [{ id: `t${i}`, type: 'text', x: 10, y: 10, w: 80, h: 30, text: `Slide title ${i + 1}`, size: 50 }] }));
const printTo = async (label, includeSkipped = false) => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Print or save as PDF…' }).click();
  const d = page.getByRole('dialog', { name: 'Print or save as PDF' });
  await d.getByLabel(label).check();
  if (includeSkipped) await d.getByLabel(/Include skipped slides/).check();
  const status = await d.getByRole('status').innerText();
  await page.evaluate(() => { window.__printed = false; window.print = () => { window.__printed = true; }; });
  await d.getByRole('button', { name: 'Print…' }).click();
  await page.waitForFunction(() => window.__printed);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const file = `${SP}/print-${label.replace(/\W+/g, '_')}.pdf`;
  fs.writeFileSync(file, pdf);
  const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
  const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString())[1]);
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(execFileSync('pdfinfo', [file]).toString());
  await page.waitForTimeout(1200); // the print is over
  return { status, text, pages, portrait: Number(size[2]) > Number(size[1]), file };
};
await step('handouts, 3 per page with lines: 6 slides on 2 portrait pages, the skipped one left out', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Quarterly review', content: { theme: 'light', slides: slidesOf() } })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByText('Slide title 1').first().waitFor();
  const r = await printTo('Handouts: 3 slides per page, with lines for notes');
  if (!/^2 pages, portrait/.test(r.status)) throw new Error(r.status);
  if (r.pages !== 2 || !r.portrait) throw new Error(`${r.pages} pages, portrait ${r.portrait}`);
  if (/Slide title 4/.test(r.text)) throw new Error('the skipped slide was printed');
  if (!/Quarterly review[\s\S]*1\s*\/\s*2[\s\S]*Slide title 1[\s\S]*Slide title 3[\s\S]*Slide title 5/.test(r.text)) throw new Error(r.text.slice(0, 400));
  execFileSync('pdftoppm', ['-png', '-r', '40', '-f', '1', '-l', '1', r.file, `${SP}/shots/handout3`]);
});
await step('slides with speaker notes: a page each, notes under the slide', async () => {
  const r = await printTo('Slides with speaker notes', true);
  if (r.pages !== 7 || !r.portrait) throw new Error(`${r.pages} pages`);
  if (!/Slide title 4[\s\S]*Notes for slide 4/.test(r.text)) throw new Error('skipped slide asked for, with its notes');
});
await step('slides on their own: landscape, a page each', async () => {
  const r = await printTo('Slides: one per page');
  if (r.pages !== 6 || r.portrait) throw new Error(`${r.pages} pages, portrait ${r.portrait}`);
  if (/Notes for slide/.test(r.text)) throw new Error('notes printed');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
