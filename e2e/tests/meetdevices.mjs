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
// A second (made-up) camera alongside Chromium's fake one, and a record of what Meet asks for.
const fakeSecond = () => {
  const md = navigator.mediaDevices;
  const enumerate = md.enumerateDevices.bind(md), gum = md.getUserMedia.bind(md);
  window.__asks = [];
  md.enumerateDevices = async () => [...await enumerate(), { kind: 'videoinput', deviceId: 'second-cam', label: 'Second camera', groupId: 'x', toJSON() { return this; } }];
  md.getUserMedia = (c) => { window.__asks.push(JSON.parse(JSON.stringify(c))); return gum(c); };
};
await page.addInitScript(fakeSecond);
const max = await mk('max');
let code;
await step('the lobby lists cameras and microphones; picking one asks for it and is remembered', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  code = (await api(page, 'POST', '/meet', { title: 'Devices' })).body.code;
  await page.goto(`${B}/meet/${code}`);
  const camSel = page.getByLabel('Camera', { exact: true });
  await until(async () => (await camSel.locator('option').evaluateAll((os) => os.map((o) => o.textContent))).includes('Second camera'));
  const mics = await page.getByLabel('Microphone', { exact: true }).locator('option').count();
  if (mics < 1) throw new Error('no microphones');
  await camSel.selectOption({ label: 'Second camera' });
  await until(async () => (await page.evaluate(() => window.__asks.at(-1)?.video?.deviceId?.ideal)) === 'second-cam');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nw-meet-devices')));
  if (saved.cam !== 'second-cam') throw new Error(JSON.stringify(saved));
  await page.getByLabel('Your camera').waitFor();
});
await step('the lobby: the microphone meter moves (the fake microphone beeps); Test speaker plays on the chosen speaker', async () => {
  const meter = page.getByRole('meter', { name: 'Microphone level' });
  await until(async () => Number(await meter.getAttribute('aria-valuenow') ?? await meter.evaluate((m) => m.value)) > 0, 10000);
  const spk = page.getByLabel('Speaker', { exact: true });
  await until(async () => (await spk.locator('option').count()) >= 2);
  const outs = await spk.locator('option').evaluateAll((os) => os.map((o) => o.value));
  const pickId = outs.find((v) => v !== 'default') || outs[1];
  await spk.selectOption(pickId);
  await page.getByRole('button', { name: '🔊 Test speaker' }).click();
  await page.getByRole('button', { name: '🔊 Playing…' }).waitFor();
  const st = () => page.evaluate(() => { const a = document.querySelector('audio[aria-label="Speaker test"]'); return [a.sinkId, !!a.srcObject]; });
  await until(async () => { const [sink, src] = await st(); return sink === pickId && src; }, 3000).catch(async () => { throw new Error(JSON.stringify(await st())); });
  await page.getByRole('button', { name: '🔊 Test speaker' }).waitFor({ timeout: 3000 });
});
await step('next time, the saved camera is asked for straight away', async () => {
  await page.reload();
  await until(async () => (await page.evaluate(() => window.__asks[0]?.video?.deviceId?.ideal)) === 'second-cam');
});
await step('in the meeting: ⚙ shows the same choices; switching keeps Max seeing a picture', async () => {
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  const seen = max.getByLabel('Video of Olivia Owner');
  await until(() => seen.evaluate((v) => v.readyState >= 2 && v.videoWidth > 0), 15000);
  await page.getByRole('button', { name: 'Audio and video settings' }).click();
  const panel = page.getByRole('complementary', { name: 'Audio and video settings' });
  const camSel = panel.getByLabel('Camera', { exact: true });
  await until(async () => (await camSel.locator('option').count()) >= 2); // the list loads a moment after the panel opens
  const now = await camSel.inputValue();
  const real = [(await camSel.locator('option').evaluateAll((os) => os.map((o) => o.value))).find((v) => v !== now)];
  const before = await page.evaluate(() => window.__asks.length);
  await camSel.selectOption(real[0]);
  await until(async () => (await page.evaluate(() => window.__asks.length)) > before);
  await page.waitForTimeout(1500);
  if (!(await seen.evaluate((v) => v.readyState >= 2 && v.videoWidth > 0 && !v.srcObject.getVideoTracks()[0].muted))) throw new Error('Max lost the picture');
  if (await page.getByText(/couldn.t|No camera or microphone could be used/).count()) throw new Error('error shown');
});
await step('⚙ Speaker: the others are heard on the one chosen, remembered', async () => {
  const panel = page.getByRole('complementary', { name: 'Audio and video settings' });
  const spk = panel.getByLabel('Speaker', { exact: true });
  const outs = await spk.locator('option').evaluateAll((os) => os.map((o) => o.value));
  if (outs.length < 2) throw new Error(`speakers: ${outs.length}`);
  const pickId = outs.find((v) => v !== 'default') || outs[1];
  await spk.selectOption(pickId);
  const maxVideo = page.getByLabel('Video of Max Meet');
  await until(async () => (await maxVideo.evaluate((v) => v.sinkId)) === pickId);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nw-meet-devices')));
  if (saved.spk !== pickId) throw new Error(JSON.stringify(saved));
  if (await page.getByLabel('Your camera').count() && await page.getByLabel('Video of Olivia Owner (you)').evaluate((v) => v.sinkId).catch(() => '') === pickId) throw new Error('your own (muted) video needs no speaker');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
