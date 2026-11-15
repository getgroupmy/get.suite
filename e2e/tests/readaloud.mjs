import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
// Headless Chromium has no voices: a stand-in speechSynthesis that records what it's asked to say and
// "finishes" each sentence when the test says so (window.__finish()).
const FAKE = () => {
  const said = []; let current = null; let paused = false;
  window.__said = said;
  window.SpeechSynthesisUtterance = function (text) { this.text = text; this.rate = 1; this.voice = null; this.lang = ''; };
  const synth = {
    speak(u) { said.push({ text: u.text, rate: u.rate }); current = u; },
    cancel() { const u = current; current = null; if (u?.onerror) u.onerror({ error: 'interrupted' }); },
    pause() { paused = true; }, resume() { paused = false; },
    get paused() { return paused; }, get speaking() { return !!current; },
    getVoices() { return [{ name: 'Test Voice', lang: 'en-GB', voiceURI: 'test-gb' }, { name: 'Other Voice', lang: 'en-US', voiceURI: 'test-us' }]; },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.__finish = () => { const u = current; current = null; u?.onend?.({}); };
  window.__paused = () => paused;
  // And speech recognition: window.__hear(text, final) as if it was said; window.__rec the one listening.
  window.SpeechRecognition = function () { window.__rec = this; this.started = 0; this.stopped = false; this.lang = ''; };
  window.SpeechRecognition.prototype.start = function () { this.started++; this.stopped = false; setTimeout(() => this.onstart?.(), 0); };
  window.SpeechRecognition.prototype.stop = function () { this.stopped = true; };
  window.__hear = (text, final = true) => {
    const r = window.__rec; const res = [{ transcript: text }]; res.isFinal = final;
    r.onresult?.({ resultIndex: 0, results: [res] });
  };
  window.__pause = () => window.__rec.onend?.(); // the browser stops after a silence
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
const said = () => page.evaluate(() => window.__said.map((x) => x.text));
const now = () => page.locator('.paper .reading-now').allInnerTexts().then((t) => t.join(''));
const bar = () => page.getByRole('region', { name: 'Read aloud' });
let docId;
await step('setup: a document', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Briefing', content: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('Quarterly briefing')] },
    { type: 'paragraph', content: [t('Sales rose by 4% this quarter. '), t('Dr. Lee', [{ type: 'bold' }]), t(' leads the new team. Questions go to her.')] },
    { type: 'paragraph', content: [t('Next review is in March.')] },
  ] } })).body.id;
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('Questions go to her.').waitFor();
});
await step('⋮ → Read aloud reads from the cursor, a sentence at a time, highlighting each', async () => {
  await page.locator('.paper .tiptap').getByText('Quarterly briefing').click();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Read aloud' }).click();
  await bar().getByText('Reading aloud: sentence 1 of 5').waitFor();
  await until(async () => (await now()) === 'Quarterly briefing');
  if ((await said()).join('|') !== 'Quarterly briefing') throw new Error(await said());
  await page.evaluate(() => window.__finish());
  await bar().getByText('sentence 2 of 5').waitFor();
  await until(async () => (await now()) === 'Sales rose by 4% this quarter.');
  await page.evaluate(() => window.__finish());
  await until(async () => (await now()) === 'Dr. Lee leads the new team.'); // across bold, and not split at "Dr."
  await page.screenshot({ path: `${SP}/shots/readaloud.png` });
  await axe(page, 'read aloud');
});
await step('pause and go on; skip forward and back; a new speed applies from the sentence being read', async () => {
  await bar().getByRole('button', { name: '⏸ Pause' }).click();
  if (!(await page.evaluate(() => window.__paused()))) throw new Error('not paused');
  await bar().getByRole('button', { name: '▶ Go on' }).click();
  if (await page.evaluate(() => window.__paused())) throw new Error('still paused');
  await bar().getByRole('button', { name: 'Next sentence' }).click();
  await until(async () => (await now()) === 'Questions go to her.');
  await bar().getByRole('button', { name: 'Previous sentence' }).click();
  await until(async () => (await now()) === 'Dr. Lee leads the new team.');
  await bar().getByLabel('Reading speed').selectOption('1.5');
  await until(() => page.evaluate(() => window.__said.at(-1).rate === 1.5 && window.__said.at(-1).text === 'Dr. Lee leads the new team.'));
  await bar().getByLabel('Voice').selectOption('test-us');
  await bar().getByRole('button', { name: 'Next sentence' }).click();
  await bar().getByRole('button', { name: 'Next sentence' }).click();
  await until(async () => (await now()) === 'Next review is in March.');
  await page.evaluate(() => window.__finish());
  await bar().getByText('Finished reading').waitFor();
  if (await page.locator('.paper .reading-now').count()) throw new Error('still highlighted');
});
await step('the speed is remembered; Ctrl+Alt+R starts and stops it from the cursor; Stop clears the highlight', async () => {
  await bar().getByRole('button', { name: 'Stop' }).click();
  await bar().waitFor({ state: 'detached' });
  await page.locator('.paper .tiptap').getByText('Next review is in March.').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Control+Alt+r');
  await bar().getByText('Reading aloud: sentence 1 of 1').waitFor();
  if (await bar().getByLabel('Reading speed').inputValue() !== '1.5') throw new Error('speed not kept');
  await until(async () => (await now()) === 'Next review is in March.');
  await page.keyboard.press('Control+Alt+r');
  await bar().waitFor({ state: 'detached' });
  if (await page.locator('.paper .reading-now').count()) throw new Error('highlight left behind');
  if (await page.locator('.paper .tiptap').innerText().then((t) => !t.includes('Quarterly briefing'))) throw new Error('document changed');
});
await step('⋮ → Voice typing types what’s said at the cursor, with spoken punctuation; it keeps listening after a pause', async () => {
  await page.locator('.paper .tiptap').getByText('Next review is in March.').click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Voice typing' }).click();
  const vb = page.getByRole('region', { name: 'Voice typing' });
  await vb.getByText('Listening: speak, and it’s typed where the cursor is').waitFor();
  await page.evaluate(() => window.__hear('bring the', false));
  await vb.getByLabel('Still hearing').getByText('bring the').waitFor();
  await page.evaluate(() => window.__hear('bring the figures comma please full stop new paragraph thanks everyone'));
  await page.locator('.paper .tiptap').getByText('Next review is in March. Bring the figures, please.').waitFor();
  await page.locator('.paper .tiptap p', { hasText: /^Thanks everyone$/ }).waitFor();
  await page.screenshot({ path: `${SP}/shots/voicetyping.png` });
  await axe(page, 'voice typing');
  const starts = await page.evaluate(() => window.__rec.started);
  await page.evaluate(() => window.__pause());
  await until(() => page.evaluate((n) => window.__rec.started === n + 1, starts));
  await vb.getByLabel('Language').selectOption('en-US');
  await until(() => page.evaluate(() => window.__rec.lang === 'en-US'));
  await page.keyboard.press('Control+Alt+v');
  await vb.waitFor({ state: 'detached' });
  await page.keyboard.press('Control+Alt+v');
  await vb.waitFor();
  await until(() => page.evaluate(() => window.__rec.lang === 'en-US')); // the language is remembered
  await vb.getByRole('button', { name: 'Stop' }).click();
  await vb.waitFor({ state: 'detached' });
  await page.getByText('All changes saved').waitFor();
});
await step('a refused microphone says so', async () => {
  await page.keyboard.press('Control+Alt+v');
  const vb = page.getByRole('region', { name: 'Voice typing' });
  await vb.getByText('Listening: speak').waitFor();
  await page.evaluate(() => window.__rec.onerror({ error: 'not-allowed' }));
  await vb.getByText(/The microphone isn’t allowed for this page/).waitFor();
  await vb.getByRole('button', { name: 'Stop' }).click();
  await vb.waitFor({ state: 'detached' });
});
await step('with voice typing turned off for the company, Docs doesn’t offer it (Read aloud stays)', async () => {
  await api(page, 'PATCH', '/orgs/current', { voice_typing: false });
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('Questions go to her.').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Read aloud' }).waitFor();
  if (await page.getByRole('menuitem', { name: 'Voice typing' }).count()) throw new Error('still offered');
  await page.keyboard.press('Escape');
  await page.locator('.paper .tiptap').getByText('Questions go to her.').click();
  await page.keyboard.press('Control+Alt+v');
  await page.waitForTimeout(400);
  if (await page.getByRole('region', { name: 'Voice typing' }).count()) throw new Error('the shortcut still works');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
