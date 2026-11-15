import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
// Speech recognition stand-in: window.__hear(text, final) as if it was said; window.__rec the one listening.
const FAKE = () => {
  window.SpeechRecognition = function () { window.__rec = this; this.started = 0; this.stopped = false; this.lang = ''; };
  window.SpeechRecognition.prototype.start = function () { this.started++; this.stopped = false; setTimeout(() => this.onstart?.(), 0); };
  window.SpeechRecognition.prototype.stop = function () { this.stopped = true; };
  window.__hear = (text, final = true) => {
    const r = window.__rec; const res = [{ transcript: text }]; res.isFinal = final;
    r.onresult?.({ resultIndex: 0, results: [res] });
  };
};
const mk = async (who, fake = true) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (fake) await ctx.addInitScript(FAKE);
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
let deck;
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
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Quarterly review' })).body;
  await page.goto(`${B}/slides/${deck.id}`);
});
const pres = () => page.getByRole('dialog', { name: 'Presenting' });
const captions = () => pres().getByLabel('Captions', { exact: true });
await step('CC while presenting: what is said shows along the bottom, the words still being heard too', async () => {
  await page.getByRole('button', { name: 'Present' }).first().click();
  await pres().waitFor();
  await pres().getByRole('button', { name: 'Captions' }).click();
  await page.waitForFunction(() => window.__rec && window.__rec.started > 0 && window.__rec.continuous);
  await page.evaluate(() => window.__hear('Welcome everyone'));
  await page.evaluate(() => window.__hear('to the quarterly', false));
  await captions().getByText('Welcome everyone to the quarterly').waitFor();
  await page.evaluate(() => window.__hear('to the quarterly review'));
  await captions().getByText('Welcome everyone to the quarterly review').waitFor();
  await pres().getByRole('button', { name: 'Turn off captions', pressed: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/slide-captions.png` });
  await axe(page, 'captions');
});
await step('the browser stopping after a silence: it listens again; long speech shows the latest words', async () => {
  const before = await page.evaluate(() => window.__rec.started);
  await page.evaluate(() => window.__rec.onend?.());
  await page.waitForFunction((n) => window.__rec.started > n, before);
  await page.evaluate(() => { for (let k = 0; k < 12; k++) window.__hear(`point number ${k} is about sales`); });
  const t = await captions().innerText();
  if (t.length > 140 || !t.endsWith('point number 11 is about sales') || t.includes('Welcome')) throw new Error(t);
});
await step('C turns them off (and the listening stops), and on again; a refused microphone is explained', async () => {
  await pres().focus();
  await page.keyboard.press('c');
  await page.waitForFunction(() => window.__rec.stopped);
  if (await pres().locator('.presenter-captions').count()) throw new Error('captions stayed');
  await page.keyboard.press('c');
  await page.waitForFunction(() => !window.__rec.stopped);
  await page.evaluate(() => window.__rec.onerror?.({ error: 'not-allowed' }));
  await pres().getByRole('alert').getByText(/Captions need the microphone/).waitFor();
  await page.keyboard.press('Escape');
});
await step('no speech recognition in the browser: no CC button', async () => {
  const other = await mk('plain', false);
  await other.goto(B);
  await other.evaluate(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  await other.context().addCookies(await page.context().cookies());
  await other.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  await other.goto(`${B}/slides/${deck.id}`);
  await other.getByRole('button', { name: 'Present' }).first().click();
  await other.getByRole('dialog', { name: 'Presenting' }).getByRole('button', { name: 'Laser pointer' }).waitFor();
  if (await other.getByRole('button', { name: 'Captions' }).count()) throw new Error('CC offered without speech recognition');
}, page);
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
