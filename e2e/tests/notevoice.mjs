import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
let errors = [];
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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let note;
await step('record a voice note: the time runs, ■ adds it to the note, where it plays', async () => {
  await page.context().grantPermissions(['microphone']);
  note = (await api(page, 'POST', '/notes', { title: 'Standup thoughts', body: 'Talk to Kim about the launch' })).body;
  await page.goto(`${B}/notes`);
  await page.locator('.note-card').getByText('Standup thoughts').click();
  const editor = page.getByRole('dialog', { name: 'Standup thoughts' });
  await editor.getByRole('button', { name: 'Record a voice recording' }).click();
  await editor.getByRole('status', { name: 'Recording' }).getByText(/0:0[12]/).waitFor();
  await page.waitForTimeout(1500);
  await editor.getByRole('button', { name: 'Stop recording' }).click();
  await page.getByText('Recording added').waitFor();
  const audio = editor.getByRole('list', { name: 'Recordings' }).locator('audio[aria-label="Recording 1"]');
  await audio.waitFor();
  await until(async () => audio.evaluate((a) => a.readyState >= 1), 8000); // it loads: a real recording
  const n = (await api(page, 'GET', '/notes')).body.find((x) => x.id === note.id);
  if (n.recordings.length !== 1 || !(n.recordings[0].duration_ms >= 1500 && n.recordings[0].duration_ms < 15000)) throw new Error(JSON.stringify(n.recordings));
  await page.screenshot({ path: `${SP}/shots/note-recording.png` });
  await axe(page, 'editor');
});
await step('the card says so; × takes it off', async () => {
  const editor = page.getByRole('dialog', { name: 'Standup thoughts' });
  await editor.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByText(/🎙 Recording 0:0\d/).waitFor();
  await page.locator('.note-card').getByText('Standup thoughts').click();
  await editor.getByRole('button', { name: 'Remove recording 1' }).click();
  await editor.getByRole('list', { name: 'Recordings' }).waitFor({ state: 'detached' });
  await editor.getByRole('button', { name: 'Close', exact: true }).last().click();
  if (await page.getByText(/🎙 Recording/).count()) throw new Error('chip stayed');
});
await step('throwing a recording away adds nothing', async () => {
  await page.locator('.note-card').getByText('Standup thoughts').click();
  const editor = page.getByRole('dialog', { name: 'Standup thoughts' });
  await editor.getByRole('button', { name: 'Record a voice recording' }).click();
  await page.waitForTimeout(800);
  await editor.getByRole('button', { name: 'Cancel recording' }).click();
  await page.waitForTimeout(800);
  if ((await api(page, 'GET', '/notes')).body.find((x) => x.id === note.id).recordings.length) throw new Error('kept');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
