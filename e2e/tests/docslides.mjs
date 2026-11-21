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
const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const OL = (items) => ({ type: 'orderedList', content: items.map((t) => ({ type: 'listItem', content: [P(t)] })) });
const UL = (items) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [P(t)] })) });
const lookOf = (p, tag, text) => p.locator(`.paper .tiptap ${tag}`, { hasText: text }).first().evaluate((el) => getComputedStyle(el).listStyleType);
const H = (level, t) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: t }] });
let docId;
await step('setup: a document with headings, paragraphs and lists', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const nested = UL(['Retail', 'Online']);
  const goals = { type: 'bulletList', content: [{ type: 'listItem', content: [P('Customers'), nested] }, { type: 'listItem', content: [P('Hiring')] }] };
  const steps = { type: 'orderedList', attrs: { listStyle: 'lower-roman' }, content: ['Plan', 'Build', 'Launch'].map((t) => ({ type: 'listItem', content: [P(t)] })) };
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan 2027', content: { type: 'doc', content: [P('Our plan for next year'), H(1, 'Goals'), P('Grow steadily.'), goals, H(1, 'Steps'), steps] } })).body.id;
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('Grow steadily.').waitFor();
});
await step('⋮ → Make a presentation: a new presentation, a slide for each Heading 1, its points as lists', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Make a presentation' }).click();
  await page.waitForURL(/\/slides\//);
  await page.getByText('Made “Plan 2027 (slides)”: 3 slides').waitFor();
  await page.getByRole('button', { name: 'Slide 3', exact: true }).waitFor();
  const stage = page.locator('.slide-stage > .slide');
  await stage.getByText('Plan 2027', { exact: true }).waitFor();
  await stage.getByText('Our plan for next year').waitFor();
  await page.getByRole('button', { name: 'Slide 2', exact: true }).click();
  await stage.getByText('Goals', { exact: true }).waitFor();
  await stage.getByText('Online').waitFor();
  const marks = await stage.locator('.slide-mark').allInnerTexts();
  if (marks.join() !== '●,●,–,–,●') throw new Error(marks.join());
  const indent = await stage.locator('.slide-para.listed', { hasText: 'Retail' }).evaluate((el) => parseFloat(getComputedStyle(el).marginLeft));
  if (!(indent > 0)) throw new Error('Retail not a level in');
  await page.screenshot({ path: `${SP}/shots/doc-to-slides.png` });
  await page.getByRole('button', { name: 'Slide 3', exact: true }).click();
  await stage.getByText('Launch').waitFor();
  if ((await stage.locator('.slide-mark').allInnerTexts()).join() !== 'i.,ii.,iii.') throw new Error('numbering');
  // It's in Drive, beside nothing else (the document was in My Drive).
  const files = (await api(page, 'GET', '/files')).body;
  const list = Array.isArray(files) ? files : files.files || files.items || [];
  if (!list.some((f) => f.name === 'Plan 2027 (slides)' && f.kind === 'slides')) throw new Error(JSON.stringify(list).slice(0, 300));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
