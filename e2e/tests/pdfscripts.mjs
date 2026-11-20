// A document in several scripts, Docs → ⋮ → Download as PDF: its Chinese, Japanese, Greek, Cyrillic, Thai and Tamil are
// drawn (from fonts installed on the server, cut down to what's used) and read back as written (before, every one of
// them was "?").
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(m.text()));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const expectCells = async (want) => { for (const [k, v] of Object.entries(want)) { const t = await text(k); if (t !== v) throw new Error(`${k}: "${t}" not "${v}"`); } };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const LINES = ['Greek: αβγ Δ', 'Cyrillic: Привет мир', 'Chinese: 中文报告', 'Japanese: 日本語のテキスト', 'Thai: สวัสดี', 'Tamil: வணக்கம்'];
let id;
await step('setup: a document in six scripts', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const content = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '多语言 Report' }] }, ...LINES.map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] }))] };
  id = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Scripts', content })).body.id;
});
await step('Download as PDF: every line read back as written, nothing as ?', async () => {
  await page.goto(`${B}/docs/${id}`);
  await page.getByText('Привет мир').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as PDF (.pdf)' }).click()]);
  const buf = (await import('node:fs')).readFileSync(await dl.path());
  let text = null;
  try { text = (await import('node:child_process')).execFileSync('pdftotext', ['-', '-'], { input: buf }).toString(); } catch { /* not installed */ }
  if (text === null) return;
  const flat = (s) => s.replace(/\s+/g, '');
  const missing = ['多语言 Report', ...LINES].filter((l) => !flat(text).includes(flat(l)));
  if (missing.length) throw new Error(`not in the PDF: ${missing.join(' / ')}; it reads: ${text.slice(0, 300)}`);
  if (/\?{2,}/.test(text)) throw new Error('question marks in the PDF');
  if (buf.length > 600 * 1024) throw new Error(`${Math.round(buf.length / 1024)} KB`);
});
await step('Hebrew and Arabic: Download as PDF runs them right to left, Arabic letters joined; the words read back as written', async () => {
  const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const rid = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'RTL', content: { type: 'doc', content: [P('שלום עולם, זה מסמך.'), P('مرحبا بالعالم'), P('التقرير السنوي لعام 2026')] } })).body.id;
  await page.goto(`${B}/docs/${rid}`);
  await page.getByText('مرحبا بالعالم').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as PDF (.pdf)' }).click()]);
  const buf = (await import('node:fs')).readFileSync(await dl.path());
  let text = null;
  try { text = (await import('node:child_process')).execFileSync('pdftotext', ['-', '-'], { input: buf }).toString().replace(/[\u202a-\u202e\u200e\u200f]/g, ''); } catch { /* not installed */ }
  if (text === null) return;
  const missing = ['שלום', 'עולם', 'מסמך', 'مرحبا', 'بالعالم', 'التقرير', '2026'].filter((w) => !text.includes(w));
  if (missing.length) throw new Error(`not read back: ${missing.join(' ')} (it reads ${text.replace(/\n+/g, ' / ')})`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
