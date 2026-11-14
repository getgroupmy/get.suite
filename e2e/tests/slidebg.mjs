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
const bgOf = (p) => p.locator('.slide-stage .slide').first().evaluate((el) => getComputedStyle(el).backgroundImage);
const stored = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content.slides;
await step('setup: a presentation shared with a viewer', async () => {
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
  const content = { theme: 'light', slides: [
    { id: 's1', items: [{ id: 't1', type: 'text', role: 'title', x: 10, y: 35, w: 80, h: 20, size: 40, text: 'Welcome aboard' }] },
    { id: 's2', items: [] },
  ] };
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Launch', content })).body.id;
  await api(page, 'PUT', `/files/${deckId}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/slides/${deckId}`); await p.locator('.slide-stage .slide-text', { hasText: 'Welcome aboard' }).waitFor(); }
  if ((await bgOf(page)) !== 'none') throw new Error('a picture at first');
});
await step('Background picture: behind the slide, for everyone', async () => {
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Background picture' }).waitFor();
  await page.locator('input[type=file][accept="image/png,image/jpeg,image/gif"]').setInputFiles(`${ROOT}/e2e/fixtures/blue.png`);
  await until(async () => (await bgOf(page)).includes('/pictures/'));
  const slides = await until(async () => { const s = await stored(); return s[0].bgImage && s; });
  if (slides[1].bgImage) throw new Error('only this slide');
  await until(async () => (await bgOf(kim)).includes(`/pictures/${slides[0].bgImage}`));
  // The viewer's browser really gets the picture.
  const status = await kim.evaluate(async (u) => (await fetch(u)).status, `/api/files/${deckId}/pictures/${slides[0].bgImage}`);
  if (status !== 200) throw new Error('viewer picture ' + status);
  // The title is still on top, and the thumbnail shows it too.
  await kim.locator('.slide-stage .slide-text', { hasText: 'Welcome aboard' }).waitFor();
  const thumb = await page.getByRole('button', { name: 'Slide 1', exact: true }).locator('.slide').evaluate((el) => getComputedStyle(el).backgroundImage);
  if (!thumb.includes('/pictures/')) throw new Error('thumbnail ' + thumb);
  if (!(await page.getByRole('button', { name: 'Remove background picture' }).count())) throw new Error('no remove button');
  if (await kim.getByRole('button', { name: 'Background picture' }).count()) throw new Error('the viewer can change it');
  await page.screenshot({ path: `${SP}/shots/slidebg.png` });
});
await step('In the PowerPoint download', async () => {
  const b64 = await page.evaluate(async (id) => {
    const buf = new Uint8Array(await (await fetch(`/api/files/${id}/export`)).arrayBuffer());
    let s = ''; for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, deckId);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  if (!/<p:bg>[\s\S]*<a:blip r:embed=/.test(xml)) throw new Error('no background picture in the PowerPoint slide');
  if (/<p:bg>[\s\S]*<a:blip/.test(await zip.file('ppt/slides/slide2.xml').async('string'))) throw new Error('slide 2 got one');
});
await step('Remove it, and undo', async () => {
  await page.getByRole('button', { name: 'Remove background picture' }).click();
  await until(async () => (await bgOf(kim)) === 'none');
  await until(async () => !(await stored())[0].bgImage);
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await until(async () => (await bgOf(kim)).includes('/pictures/'));
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
