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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pick = async (p, button) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), button.click()]); await fc.setFiles({ name: 'sales-chart.png', mimeType: 'image/png', buffer: PNG }); };
const DESC = 'Bar chart: sales doubled from 2025 to 2026';
const WEBM = (await import('node:fs')).readFileSync(`${ROOT}/e2e/fixtures/clip.webm`);
let deck;
await step('Slides: Video → Upload a video puts it on the slide, shown with ▶ while editing', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Product tour' })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: 'Video' }).click();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Upload a video…' }).click()]);
  await fc.setFiles({ name: 'tour.webm', mimeType: 'video/webm', buffer: WEBM });
  await page.locator('.slide-item[aria-label="Video: tour.webm"]').first().waitFor();
  await page.locator('.slide-video.editing video').first().waitFor();
  await page.waitForTimeout(2500); // saved
  const content = (await api(page, 'GET', `/files/${deck.id}/content`)).body.content;
  if (!content.slides[0].items.some((i) => i.type === 'video' && i.name === 'tour.webm')) throw new Error(JSON.stringify(content.slides[0].items));
});
await step('a colleague who can only view the presentation plays it (the video file itself isn\'t shared with them)', async () => {
  await api(page, 'POST', '/users', { local: 'vee', domain: 'acme.com', name: 'Vee Viewer', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${deck.id}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'vee@acme.com').id, role: 'viewer' }] });
  const vee = await mk('vee'); await signIn(vee, 'vee@acme.com');
  await vee.goto(`${B}/slides/${deck.id}`);
  const v = vee.getByLabel('Video: tour.webm').first();
  await v.waitFor();
  await until(async () => (await v.evaluate((el) => el.readyState)) >= 1, 15000);
  const dur = await v.evaluate((el) => el.duration);
  if (!(dur > 1.5 && dur < 2.5)) throw new Error('duration ' + dur);
  await v.evaluate((el) => { el.muted = true; return el.play(); });
  await until(async () => (await v.evaluate((el) => el.currentTime)) > 0.3, 10000);
  await vee.screenshot({ path: `${SP}/shots/slide-video.png` });
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
