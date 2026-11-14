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
let deck;
// A one-second WAV tone (8 kHz, 16-bit mono).
const wav = (() => {
  const rate = 8000, n = rate, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
})();
await step('Slides: Audio → Upload a sound puts it on the slide; Play by itself', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Narrated tour' })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: 'Audio' }).click();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Upload a sound…' }).click()]);
  await fc.setFiles({ name: 'welcome.wav', mimeType: 'audio/wav', buffer: wav });
  const box = page.locator('.slide-item[aria-label="Sound: welcome.wav"]').first();
  await box.waitFor();
  await page.locator('.slide-audio.editing').first().waitFor();
  await box.click();
  await page.getByLabel('Play by itself').check();
  await page.getByText('welcome.wav · plays by itself').waitFor();
  await page.screenshot({ path: `${SP}/shots/slide-audio-edit.png` });
  await page.waitForTimeout(2500); // saved
  const it = (await api(page, 'GET', `/files/${deck.id}/content`)).body.content.slides[0].items.find((i) => i.type === 'audio');
  if (!it || it.name !== 'welcome.wav' || it.autoplay !== true) throw new Error(JSON.stringify(it));
});
await step('presenting: it starts by itself', async () => {
  await page.getByRole('button', { name: /^Present/ }).first().click();
  const a = page.locator('.presenter-slide audio');
  await a.waitFor();
  await until(async () => (await a.evaluate((el) => !el.paused && el.currentTime > 0.1)), 10000);
  await page.keyboard.press('Escape');
});
await step('a colleague who can only view plays it (the sound file itself isn’t shared with them)', async () => {
  await api(page, 'POST', '/users', { local: 'vee', domain: 'acme.com', name: 'Vee Viewer', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${deck.id}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'vee@acme.com').id, role: 'viewer' }] });
  const vee = await mk('vee'); await signIn(vee, 'vee@acme.com');
  await vee.goto(`${B}/slides/${deck.id}`);
  const a = vee.locator('.slide-main audio, .slide-stage audio').first();
  await a.waitFor();
  await until(async () => (await a.evaluate((el) => el.readyState)) >= 1, 15000);
  const dur = await a.evaluate((el) => el.duration);
  if (!(dur > 0.9 && dur < 1.1)) throw new Error('duration ' + dur);
  if (await a.evaluate((el) => !el.paused)) throw new Error('only plays by itself when presenting');
  await vee.screenshot({ path: `${SP}/shots/slide-audio-view.png` });
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
