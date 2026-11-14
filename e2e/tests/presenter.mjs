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
let deckId, kim;
await step('setup: a two-slide presentation shared with an editor', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const t = (id, text, y) => ({ id, type: 'text', text, x: 10, y, w: 80, h: 20, size: 40 });
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch', content: { theme: 'light', slides: [{ id: 's1', items: [t('a', 'Welcome', 30)] }, { id: 's2', items: [t('b', 'The plan', 30)] }] } })).body.id;
  await api(page, 'PUT', `/files/${deckId}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/slides/${deckId}`); await p.locator('.slide-stage').getByText('Welcome').waitFor(); }
});

await step('speaker notes under each slide, shared and saved', async () => {
  await page.getByLabel('Speaker notes').fill('Thank everyone for coming.\nMention the Penang office.');
  await until(async () => (await kim.getByLabel('Speaker notes').inputValue()) === 'Thank everyone for coming.\nMention the Penang office.');
  await until(async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content.slides[0].notes === 'Thank everyone for coming.\nMention the Penang office.', 10000);
});

await step('presenter view: notes, next slide and timer in a second window that moves with the presentation', async () => {
  const [pv] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('button', { name: 'Presenter view' }).first().click()]);
  await pv.waitForLoadState();
  await pv.getByText('Slide 1 of 2').waitFor();
  await pv.getByLabel('Speaker notes').getByText('Mention the Penang office.').waitFor();
  await pv.getByLabel('Next slide').getByText('The plan').waitFor();
  await pv.getByLabel(/^Time since you started/).waitFor();
  await pv.screenshot({ path: `${SP}/shots/presenter-view.png` });
  await pv.getByRole('button', { name: 'Next ›' }).click();
  await page.locator('.presenter').getByText('2 / 2').waitFor();
  await pv.getByText('End of presentation').waitFor();
  await page.locator('.presenter').focus();
  await page.keyboard.press('ArrowLeft');
  await pv.getByText('Slide 1 of 2').waitFor();
  await page.keyboard.press('n');
  await page.locator('.presenter-notes', { hasText: 'Thank everyone for coming.' }).waitFor();
  await page.keyboard.press('Escape');
  await pv.getByText('The presentation has ended.').waitFor();
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
