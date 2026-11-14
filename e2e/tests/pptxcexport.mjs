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
const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
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
await step('a comment on a slide goes into the PowerPoint download', async () => {
  const deck = { theme: 'light', slides: [{ id: 'a', items: [{ id: 't', type: 'text', x: 5, y: 5, w: 60, h: 12, text: 'Our plan' }] }, { id: 'b', items: [{ id: 'u', type: 'text', x: 5, y: 5, w: 60, h: 12, text: 'Results' }] }] };
  const f = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch', content: deck })).body;
  await page.goto(`${B}/slides/${f.id}`);
  await page.getByText('Results').first().click(); // the second slide's thumbnail
  await page.getByRole('button', { name: 'Comment on this slide' }).click();
  await page.getByLabel('New comment').fill('Add last year for comparison');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByText('Add last year for comparison').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as PowerPoint (.pptx)' }).click()]);
  const file = `${SP}/pitch-dl.pptx`;
  await dl.saveAs(file);
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /comment/i.test(n));
  const xml = await zip.file('ppt/comments/comment2.xml')?.async('string');
  if (!xml || !/Add last year for comparison/.test(xml)) throw new Error('comments: ' + names.join(','));
  if (!/name="Olivia Owner"/.test(await zip.file('ppt/commentAuthors.xml').async('string'))) throw new Error('author');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
