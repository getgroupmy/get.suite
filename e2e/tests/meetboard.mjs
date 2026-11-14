import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
const max = await mk('max');
let code;
const videoPlaying = (p, name) => p.evaluate((n) => { const v = document.querySelector(`video[aria-label="Video of ${n}"]`); return !!v && v.videoWidth > 0 && v.readyState >= 2; }, name);
await step('colleague', async () => {
  const r = await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
});
await step('start a meeting; lobby shows the camera', async () => {
  await page.getByRole('link', { name: 'Meet', exact: true }).first().click();
  await page.getByLabel('Meeting name (optional)').fill('Standup');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.waitForURL(/\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  code = page.url().split('/meet/')[1];
  await page.getByRole('heading', { name: 'Standup' }).waitFor();
  await page.getByText('No one else is here yet').waitFor();
  await until(() => page.evaluate(() => { const v = document.querySelector('video[aria-label="Your camera"]'); return v && v.videoWidth > 0; }));
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
});
await step('colleague joins by code; both see each other', async () => {
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet`);
  await max.getByLabel('Meeting code or link').fill(code.toUpperCase().replace(/-/g, ' '));
  await max.getByRole('button', { name: 'Join', exact: true }).click();
  await max.getByText('Olivia Owner is here').waitFor();
  await max.getByRole('button', { name: 'Join now' }).click();
  await until(() => videoPlaying(page, 'Max Meet'), 20000);
  await until(() => videoPlaying(max, 'Olivia Owner'), 20000);
});
const drag = async (p, x0, y0, x1, y1) => {
  const box = await p.getByLabel('Whiteboard drawing area').boundingBox();
  const sx = box.width / 1000, sy = box.height / 600;
  await p.mouse.move(box.x + x0 * sx, box.y + y0 * sy); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(box.x + (x0 + (x1 - x0) * i / 8) * sx, box.y + (y0 + (y1 - y0) * i / 8) * sy);
  await p.mouse.up();
};
/** The colour at board point (x, y) on someone's whiteboard. */
const px = (p, x, y) => p.getByLabel('Whiteboard drawing area').evaluate((c, [x, y]) => [...c.getContext('2d').getImageData(Math.round(x * c.width / 1000), Math.round(y * c.height / 600), 1, 1).data].slice(0, 3), [x, y]);
const isBlue = (c) => c[2] > 150 && c[0] < 100;
const isWhite = (c) => c.every((v) => v > 240);
await step('Olivia opens the whiteboard and draws; Max is told and sees it when he opens it', async () => {
  await page.getByRole('button', { name: 'Whiteboard', exact: true }).click();
  await page.getByRole('region', { name: 'Whiteboard' }).waitFor();
  const tools = page.getByRole('toolbar', { name: 'Whiteboard tools' });
  await tools.getByRole('radio', { name: /Box/ }).click();
  await tools.getByRole('button', { name: 'Ink Blue' }).click();
  await drag(page, 100, 100, 300, 250);
  await max.getByText('Olivia Owner is drawing on the whiteboard').waitFor();
  await max.getByRole('button', { name: 'Whiteboard, 1 new' }).click();
  await until(async () => isBlue(await px(max, 100, 175)));
  if (!isWhite(await px(max, 200, 175))) throw new Error('a box is an outline');
});
await step('Max draws an arrow; both see both; his Undo takes back only his', async () => {
  const tools = max.getByRole('toolbar', { name: 'Whiteboard tools' });
  await tools.getByRole('radio', { name: /Arrow/ }).click();
  await tools.getByRole('button', { name: 'Ink Red' }).click();
  await drag(max, 400, 300, 800, 300);
  const isRed = (c) => c[0] > 180 && c[1] < 100;
  await until(async () => isRed(await px(page, 600, 300)));
  await page.screenshot({ path: `${SP}/shots/meet-board.png` });
  await tools.getByRole('button', { name: 'Undo' }).click();
  await until(async () => isWhite(await px(page, 600, 300)) && isWhite(await px(max, 600, 300)));
  if (!isBlue(await px(page, 100, 175))) throw new Error("Olivia's box went too");
});
await step('Save to Drive keeps it as a picture in Olivia\'s Drive; Clear empties it for everyone', async () => {
  await page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Save to Drive' }).click();
  await page.getByText(/Saved to your Drive as “Whiteboard – Standup/).waitFor();
  const files = (await api(page, 'GET', '/files')).body;
  if (!files.some((f) => /^Whiteboard – Standup.*\.png$/.test(f.name) && f.size > 1000)) throw new Error(files.map((f) => f.name).join(', '));
  await max.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Clear' }).click();
  await until(async () => isWhite(await px(page, 100, 175)));
});
await step('no errors', async () => { if (errors.length) throw new Error(errors.slice(0, 3).join(' | ')); });
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
