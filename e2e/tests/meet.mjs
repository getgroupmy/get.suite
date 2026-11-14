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
await step('mute and camera off show to the other side', async () => {
  await max.getByRole('button', { name: 'Turn off microphone' }).click();
  await page.locator('.meet-tile[data-name="Max Meet"]').getByLabel('muted').waitFor();
  await max.getByRole('button', { name: 'Turn off camera' }).click();
  await until(async () => !(await page.locator('.meet-tile[data-name="Max Meet"] .meet-avatar').count()) === false);
  await max.getByRole('button', { name: 'Turn on camera' }).click();
  await until(async () => (await page.locator('.meet-tile[data-name="Max Meet"] .meet-avatar').count()) === 0);
});
await step('raise hand and react', async () => {
  await max.getByRole('button', { name: 'Raise hand' }).click();
  await page.locator('.meet-tile[data-name="Max Meet"]').getByLabel('Hand raised').waitFor();
  await page.getByRole('button', { name: 'People' }).click();
  await page.getByRole('complementary', { name: 'People' }).getByText('Max Meet').first().waitFor();
  await max.getByRole('button', { name: 'Lower hand' }).click();
  await until(async () => (await page.locator('.meet-tile[data-name="Max Meet"].hand').count()) === 0);
  await max.getByRole('button', { name: 'React 🎉' }).click();
  await page.locator('.meet-tile[data-name="Max Meet"] .meet-floats').getByText('🎉').waitFor();
});
await step('meeting chat', async () => {
  await page.getByRole('button', { name: 'Chat' }).click();
  await page.getByLabel('Send a message to everyone').fill('Can everyone see my screen?');
  await page.getByLabel('Send a message to everyone').press('Enter');
  await max.getByRole('button', { name: 'Chat, 1 new' }).click();
  await max.getByRole('complementary', { name: 'Meeting chat' }).getByText('Can everyone see my screen?').waitFor();
  await max.getByRole('button', { name: 'Raise hand' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SP}/shots/meet-call.png` });
  await max.getByRole('button', { name: 'Lower hand' }).click();
});
await step('recent meetings list shows people in it', async () => {
  const r = (await api(max, 'GET', '/meet')).body;
  if (r[0]?.code !== code || r[0].people !== 2) throw new Error(JSON.stringify(r));
});
await step('leaving: the other side sees them go', async () => {
  await max.getByRole('button', { name: 'Leave the meeting' }).click();
  await max.getByRole('heading', { name: 'You left the meeting' }).waitFor();
  await until(async () => (await page.locator('.meet-tile[data-name="Max Meet"]').count()) === 0);
  await max.getByRole('button', { name: 'Rejoin' }).click();
  await max.getByRole('button', { name: 'Join now' }).click();
  try { await until(() => videoPlaying(page, 'Max Meet'), 20000); } catch (e) {
    const info = async (p) => p.evaluate(() => [...document.querySelectorAll('.meet-tile')].map((t) => { const v = t.querySelector('video'); return `${t.dataset.name}: ${t.querySelector('.meet-name')?.textContent} video=${!!v} w=${v?.videoWidth} rs=${v?.readyState} tracks=${v?.srcObject?.getTracks().map((x) => x.kind + ':' + x.readyState + ':' + x.enabled).join(',')}`; }));
    console.log('DBG page', JSON.stringify(await info(page)));
    console.log('DBG max', JSON.stringify(await info(max)));
    throw e;
  }
});
await step('unknown code', async () => {
  await max.goto(`${B}/meet/zzz-zzzz-zzz`);
  await max.getByRole('heading', { name: 'Can’t join this meeting' }).waitFor();
});
await step('phone width', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  if (w > 390) throw new Error(`scrolls sideways: ${w}`);
  await page.screenshot({ path: `${SP}/shots/meet-phone.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
