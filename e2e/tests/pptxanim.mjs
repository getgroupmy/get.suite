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
const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
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
let file;
await step('animated boxes go into the PowerPoint download as entrance effects', async () => {
  const content = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 't', type: 'text', x: 5, y: 5, w: 60, h: 12, text: 'Plan for spring' },
    { id: 'a', type: 'text', x: 5, y: 25, w: 60, h: 10, text: 'Hire two people', anim: 'fly', animAt: 1 },
    { id: 'b', type: 'text', x: 5, y: 40, w: 60, h: 10, text: 'Open the second shop', anim: 'fade', animAt: 2 },
  ] }] };
  const id = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Spring', content })).body.id;
  await page.goto(`${B}/slides/${id}`);
  await page.getByText('Open the second shop').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as PowerPoint (.pptx)' }).click()]);
  file = `${SP}/anim-dl.pptx`;
  await dl.saveAs(file);
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(file));
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  if (!/<p:timing>/.test(xml) || (xml.match(/presetClass="entr"/g) || []).length !== 2 || !/presetID="2"/.test(xml) || !/presetID="10"/.test(xml)) throw new Error(xml.slice(xml.indexOf('<p:timing'), xml.indexOf('<p:timing') + 500));
});
await step('the file opens back in Slides with the same animations, in order', async () => {
  const b64 = (await import('node:fs')).readFileSync(file).toString('base64');
  const up = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=Spring.pptx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
    return r.json();
  }, b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  if (opened.status >= 300) throw new Error(JSON.stringify(opened));
  await page.goto(`${B}/slides/${opened.body.id}`);
  await page.locator('.anim-badge').nth(1).waitFor();
  const box = page.locator('.slide-stage [aria-label^="Text: Hire two people"]');
  await box.click({ timeout: 5000 });
  const sel = page.getByLabel('Animation');
  await until(async () => (await sel.inputValue()) === 'fly');
  await page.screenshot({ path: `${SP}/shots/pptx-anim-in.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
