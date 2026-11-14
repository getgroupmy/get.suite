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
let docId, kim;
const para = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined });
const long = 'This clause runs on for a while so that it wraps onto several lines of the page: the parties agree that the goods will be delivered on time, in good condition, and to the address given in the order.';
const nums = (p) => p.locator('.line-numbers span').count();
const numberAt = (p, text) => p.evaluate((t) => {
  const el = [...document.querySelectorAll('.ProseMirror p, .ProseMirror h2')].find((x) => x.textContent.includes(t));
  const { top, left } = el.getBoundingClientRect();
  const span = [...document.querySelectorAll('.line-numbers span')].map((s) => ({ n: Number(s.textContent), r: s.getBoundingClientRect() }))
    .find((s) => s.r.top <= top + 8 && s.r.bottom >= top + 8 && s.r.left < left && s.r.left > left - 60);
  return span ? { n: span.n, left: Math.round(span.r.left), textLeft: Math.round(el.getBoundingClientRect().left) } : null;
}, text);
const setup = async (fn) => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  await fn(dlg);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Page setup saved' }).last().waitFor();
};
await step('setup: a contract shared with an editor', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const table = { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para('In a table')] }, { type: 'tableCell', content: [para('Not numbered')] }] }] };
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Contract', content: { type: 'doc', content: [
    para('Short one.'), para(long), para(''), { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Terms' }] }, table, para('The end.'),
  ] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/docs/${docId}`); await p.getByText('The end.').waitFor(); }
  if (await nums(page)) throw new Error('numbers before asked');
});
let total;
await step('Page setup → Line numbers: every line, beside it, for everyone', async () => {
  await setup(async (dlg) => { await dlg.getByLabel('Line numbers in the margin').check(); });
  await until(async () => (await nums(page)) > 0);
  const wrapped = await page.locator('.ProseMirror p', { hasText: 'This clause' }).evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  if (wrapped < 2) throw new Error('the long clause should wrap: ' + wrapped);
  total = await nums(page);
  // Short one (1) + the clause + an empty line (1) + the heading (1) + The end. (1); the table not counted
  if (total !== wrapped + 4) throw new Error(`lines ${total}, expected ${wrapped + 4}`);
  const first = await numberAt(page, 'Short one.');
  const end = await numberAt(page, 'The end.');
  const head = await numberAt(page, 'Terms');
  if (first?.n !== 1 || head?.n !== wrapped + 3 || end?.n !== total) throw new Error(JSON.stringify({ first, head, end }));
  if (!(end.left < end.textLeft && end.left > end.textLeft - 60)) throw new Error('number not in the margin beside the line ' + JSON.stringify(end));
  await until(async () => (await nums(kim)) === total);
  await page.screenshot({ path: `${SP}/shots/linenumbers.png` });
});
await step('Typing more lines numbers them as they come', async () => {
  await page.getByText('The end.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Signed by both parties.');
  await until(async () => (await nums(page)) === total + 1);
  await until(async () => (await nums(kim)) === total + 1);
  if ((await numberAt(kim, 'Signed by both parties.'))?.n !== total + 1) throw new Error('kim: new line number');
});
await step('In two columns, and when printed', async () => {
  await setup(async (dlg) => { await dlg.getByRole('radio', { name: 'Two' }).click(); });
  await until(async () => (await page.locator('.paper .ProseMirror').evaluate((el) => getComputedStyle(el).columnCount)) === '2');
  await until(async () => { const a = await numberAt(page, 'Short one.'), b = await numberAt(page, 'Signed by both parties.'); return a && b && a.n === 1 && (b.left > a.left + 200 || b.left === a.left); });
  for (const t of ['Short one.', 'Terms', 'Signed by both parties.']) { const x = await numberAt(page, t); if (!x || !(x.left < x.textLeft && x.left > x.textLeft - 60)) throw new Error(`columns: ${t} ${JSON.stringify(x)}`); }
  await page.emulateMedia({ media: 'print' });
  await until(async () => { const x = await numberAt(page, 'Signed by both parties.'); return x && x.left < x.textLeft && x.left > x.textLeft - 60; });
  await page.emulateMedia({ media: 'screen' });
  await setup(async (dlg) => { await dlg.getByRole('radio', { name: 'One' }).click(); await dlg.getByLabel('Line numbers in the margin').uncheck(); });
  await until(async () => (await nums(page)) === 0);
  await until(async () => (await nums(kim)) === 0);
});
await step('The word counter moves over when the outline is open', async () => {
  await page.keyboard.press('Control+Shift+c');
  const dlg = page.getByRole('dialog', { name: 'Word count' });
  await dlg.getByLabel('Display word count while typing').check();
  await dlg.getByRole('button', { name: 'OK' }).click();
  await page.locator('.word-counter').waitFor();
  await page.getByRole('button', { name: 'Outline' }).click();
  await page.locator('.doc-outline').waitFor();
  const [o, c] = await Promise.all([page.locator('.doc-outline').boundingBox(), page.locator('.word-counter').boundingBox()]);
  if (c.x < o.x + o.width) throw new Error(`overlap: outline ends ${o.x + o.width}, counter at ${c.x}`);
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
