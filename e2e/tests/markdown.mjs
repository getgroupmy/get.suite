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
await step('open a Markdown file as a document', async () => {
  const md = '# Minutes\n\nWe agreed on **three** things:\n\n- [x] budget\n- [ ] hiring\n\n&#32;&#32;Note: <u>signed</u> off.\n';
  await page.evaluate(async (text) => fetch('/api/files/upload?name=minutes.md', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: text }), md);
  await page.goto(B + '/drive');
  await page.getByLabel('Actions for minutes.md').click();
  await page.getByRole('menuitem', { name: 'Open as document' }).click();
  await page.waitForURL(/\/docs\//);
  await page.getByRole('heading', { name: 'Minutes' }).waitFor();
  await page.locator('.paper strong', { hasText: 'three' }).waitFor();
  await page.locator('.paper li[data-checked="true"]', { hasText: 'budget' }).waitFor();
  await page.locator('.paper u', { hasText: 'signed' }).waitFor(); // <u> is underline, and &#32; a space kept
  if (!(await page.locator('.paper p', { hasText: 'Note:' }).innerText()).startsWith('  Note:')) throw new Error('the spaces starting the paragraph');
});
await step('download a document as Markdown', async () => {
  await page.locator('.paper p', { hasText: 'We agreed' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Done.');
  await page.waitForTimeout(300); // sent to the server, not yet saved (that waits 2 s)
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Markdown (.md)' }).click()]);
  if (dl.suggestedFilename() !== 'minutes.md') throw new Error(dl.suggestedFilename());
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!text.startsWith('# Minutes\n\nWe agreed on **three** things: Done.\n\n- [x] budget\n- [ ] hiring')) throw new Error(JSON.stringify(text));
  if (!text.includes('&#32;&#32;Note: <u>signed</u> off.')) throw new Error(`underline and leading spaces: ${JSON.stringify(text)}`);
});
await step('a Markdown file written by another program: ***both***, escaped stars inside bold, <s> and ~~~struck~~~', async () => {
  const md = 'Plan: ***both*** and **\\*starred\\*** then <s>gone</s> and ~~~tilde~~~ end.\n\n- a list\n\n<!-- -->\n\n    indented code\n    second line\n';
  await page.evaluate(async (text) => fetch('/api/files/upload?name=other.md', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: text }), md);
  await page.goto(B + '/drive');
  await page.getByLabel('Actions for other.md').click();
  await page.getByRole('menuitem', { name: 'Open as document' }).click();
  await page.waitForURL(/\/docs\//);
  const ed = page.locator('.ProseMirror').first();
  await ed.getByText('Plan:').waitFor();
  const got = await ed.evaluate((el) => [el.textContent, el.querySelector('strong em, em strong')?.textContent, el.querySelector('strong')?.textContent, [...el.querySelectorAll('s')].map((x) => x.textContent).join('|')]);
  // (were "Plan: *both* and …" with a bold "*both", "*starred\" bold and a stray "*", and <s>gone</s> as it was written)
  if (JSON.stringify(got) !== JSON.stringify(['Plan: both and *starred* then gone and ~tilde~ end.a listindented code\nsecond line', 'both', 'both', 'gone|~tilde~'])) throw new Error(JSON.stringify(got));
  if ((await ed.locator('pre').textContent()) !== 'indented code\nsecond line') throw new Error('indented code isn\'t a code block'); // (the <!-- --> between pandoc writes isn't text either)
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
