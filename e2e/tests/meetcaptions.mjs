import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
let failed = 0;
// Speech recognition stand-in: window.__hear(text, final) as if it was said; window.__rec the one listening.
const FAKE = () => {
  window.SpeechRecognition = function () { window.__rec = this; this.started = 0; this.stopped = false; };
  window.SpeechRecognition.prototype.start = function () { this.started++; this.stopped = false; };
  window.SpeechRecognition.prototype.stop = function () { this.stopped = true; };
  window.__hear = (text, final = true) => { const r = window.__rec; const res = [{ transcript: text }]; res.isFinal = final; r.onresult?.({ resultIndex: 0, results: [res] }); };
};
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(FAKE);
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

const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document.querySelector('.meet-captions') || document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const caps = (p) => p.getByRole('region', { name: 'Captions' });
await step('CC on for both: what Max says shows for Olivia under his name, and for Max as You', async () => {
  await page.getByRole('button', { name: 'Captions' }).click();
  await max.getByRole('button', { name: 'Captions' }).click();
  await until(() => max.evaluate(() => !!window.__rec && window.__rec.started > 0 && !window.__rec.stopped));
  await max.evaluate(() => window.__hear('good morning', false));
  await caps(page).getByText('Max Meet: good morning').waitFor();
  await max.evaluate(() => window.__hear('good morning everyone'));
  await caps(page).getByText('Max Meet: good morning everyone').waitFor();
  await caps(max).getByText('You: good morning everyone').waitFor();
  await max.evaluate(() => window.__hear('shall we start'));
  await caps(page).getByText('Max Meet: good morning everyone shall we start').waitFor();
  await page.screenshot({ path: `${SP}/shots/meet-captions.png` });
  await axe(page, 'meet captions');
});
await step('two speakers: each on their own line, the latest last', async () => {
  await until(() => page.evaluate(() => !!window.__rec && window.__rec.started > 0));
  await page.evaluate(() => window.__hear('yes let us begin'));
  await caps(max).getByText('Olivia Owner: yes let us begin').waitFor();
  const lines = await caps(max).locator('p').allInnerTexts();
  if (lines.length !== 2 || !lines[1].startsWith('Olivia Owner')) throw new Error(JSON.stringify(lines));
});
await step('Keep a transcript: everyone is told; stopping saves who said what to Drive as a document', async () => {
  await page.getByRole('button', { name: 'Keep a transcript' }).click();
await max.getByRole('status').getByText('Olivia Owner is keeping a transcript of the captions').waitFor();
  await page.getByRole('status').getByText('You are keeping a transcript of the captions').waitFor();
  await max.evaluate(() => window.__hear('the budget is approved'));
  await max.evaluate(() => window.__hear('not yet final', false)); // never finished: not in the transcript
  await page.evaluate(() => window.__hear('great news thank you'));
await caps(page).getByText(/^You: .*great news thank you$/).waitFor();
  await page.getByRole('button', { name: 'Stop and save the transcript' }).click();
  await page.getByText(/^Saved “Standup transcript .+” to your Drive$/).waitFor();
  await until(async () => !(await max.getByText(/keeping a transcript/).count()));
  const f = await until(async () => (await api(page, 'GET', '/files')).body.find((x) => /^Standup transcript /.test(x.name)));
  const text = JSON.stringify((await api(page, 'GET', `/files/${f.id}/content`)).body);
  for (const want of ['Standup: transcript', 'Max Meet:', 'the budget is approved', 'Olivia Owner:', 'great news thank you']) if (!text.includes(want)) throw new Error(`missing ${want}: ${text.slice(0, 400)}`);
  if (text.includes('not yet final')) throw new Error('kept words still being heard');
  if (!(await max.getByRole('button', { name: 'Keep a transcript' }).count())) throw new Error('Max has no button');
});
await step('microphone off: your words stop being heard; CC off: no captions shown', async () => {
  await max.getByRole('button', { name: 'Turn off microphone' }).click();
  await until(() => max.evaluate(() => window.__rec.stopped));
  await page.getByRole('button', { name: 'Turn off captions' }).click();
  if (await caps(page).count()) throw new Error('captions stayed');
  await max.getByRole('button', { name: 'Turn on microphone' }).click();
  await until(() => max.evaluate(() => !window.__rec.stopped));
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
