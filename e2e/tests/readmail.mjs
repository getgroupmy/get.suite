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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
const AXE = (await import('node:fs')).readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const put = (subject, text) => page.evaluate(async ([s, t]) => (await fetch('/api/mail/messages/upload?folder=INBOX', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'message/rfc822' },
  body: `From: "Raj Kumar" <raj@acme.com>\r\nTo: olivia@acme.com\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/\W/g, '')}@x>\r\nDate: ${new Date().toUTCString()}\r\n\r\n${t}` })).status, [subject, text]);
const bar = () => page.getByRole('region', { name: 'Read aloud' });
const said = () => page.evaluate(() => window.__said.map((x) => x.text));
await step('a message’s ⋮ → Read aloud says who it’s from, the subject, then the message, not the quotes or signature', async () => {
  for (const [s, t] of [['Site visit', 'Hi Olivia,\r\n\r\nThe visit is at 10. Please bring the\r\nplans.\r\n\r\n> an old line\r\n\r\nThanks!\r\n-- \r\nRaj Kumar\r\n'], ['Other news', 'Nothing much.\r\n']]) {
    const st = await put(s, t);
    if (st >= 300) throw new Error(`upload ${st}`);
  }
  await page.goto(`${B}/mail/INBOX`);
  await page.locator('.msg-subject', { hasText: 'Site visit' }).first().click();
  await page.locator('.mail-reader').getByText('Please bring the').waitFor();
  await page.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'Read aloud' }).click();
  await bar().getByText('Reading aloud: sentence 1 of 6').waitFor();
  await bar().getByText('From Raj Kumar.').waitFor();
  for (let i = 0; i < 5; i++) await page.evaluate(() => window.__finish());
  await bar().getByText('Thanks!').waitFor();
  await page.screenshot({ path: `${SP}/shots/readmail.png` });
  await axe(page, 'read aloud in mail');
  await page.evaluate(() => window.__finish());
  await bar().getByText('Finished reading').waitFor();
  const all = (await said()).join('|');
  if (all !== 'From Raj Kumar.|Site visit.|Hi Olivia,|The visit is at 10.|Please bring the plans.|Thanks!') throw new Error(all);
});
await step('opening another message stops the reading', async () => {
  await page.getByRole('button', { name: 'More for this message' }).click();
  await page.getByRole('menuitem', { name: 'Read aloud' }).click();
  await bar().getByText('Reading aloud: sentence 1 of 6').waitFor();
  await page.locator('.msg-subject', { hasText: 'Other news' }).first().click();
  await page.locator('.mail-reader').getByText('Nothing much.').waitFor();
  await bar().waitFor({ state: 'detached' });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
