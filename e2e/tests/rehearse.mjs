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
let deck;
await step('Rehearse times each slide; the summary shows them and compares with last time', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch' })).body;
  const cur = (await api(page, 'GET', `/files/${deck.id}/content`)).body;
  await api(page, 'PUT', `/files/${deck.id}/content`, { version: cur.file.version, content: { ...cur.content, slides: [...cur.content.slides, { id: 's2', items: [] }, { id: 's3', items: [] }] } });
  await page.goto(`${B}/slides/${deck.id}`);
  for (let run = 0; run < 2; run++) {
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Rehearse (time each slide)' }).click();
    const pres = page.getByRole('dialog', { name: 'Presenting' });
    await pres.getByRole('timer', { name: 'Rehearsal timer' }).waitFor();
    await page.waitForTimeout(1200);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(700);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    const sum = page.getByRole('dialog', { name: 'Rehearsal' });
    await sum.getByRole('table', { name: 'Time on each slide' }).waitFor();
    const rows = await sum.locator('tr').count();
    if (rows !== 3) throw new Error(`${rows} rows`);
    if (run === 1) await sum.getByText(/last time \d+:\d\d/).waitFor();
    if (run === 1) await page.screenshot({ path: `${SP}/shots/rehearsal.png` });
    await sum.getByRole('button', { name: 'Done' }).click();
    await sum.waitFor({ state: 'detached' });
  }
  const kept = (await api(page, 'GET', `/slide-qa/rehearsals/${deck.id}`)).body;
  if (kept.length !== 2 || kept[0].slides.length !== 3 || kept[0].total_ms < 2000) throw new Error(JSON.stringify(kept[0]));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
