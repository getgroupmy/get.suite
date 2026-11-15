// e2e-env: MAIL_IMAGE_ALLOW_PRIVATE=1 MAIL_IMAGE_ALLOW_PORTS=8187
import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
const upload = (name, text) => page.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
// A picture server on this machine, standing in for a sender's: it records who asked.
const http = await import('node:http');
const seen = [];
const pics = http.createServer((req, res) => {
  seen.push({ url: req.url, ua: req.headers['user-agent'] || '', cookie: req.headers.cookie || '', referer: req.headers.referer || '' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  res.writeHead(200, { 'content-type': 'image/png' }); res.end(png);
});
await new Promise((r) => pics.listen(8187, '127.0.0.1', r));
const PIC = 'http://127.0.0.1:8187';
await step('an email with pictures from the internet: hidden until asked, then loaded through Workspace', async () => {
  const html = `<p>Our <b>autumn</b> sale!</p><img alt="Banner" width="40" height="40" src="${PIC}/banner.png?id=olivia"><a href="https://shop.example.com/sale">Shop now</a><img alt="" src="${PIC}/open.gif?track=1">`;
  const eml = `From: "Shop" <news@shop.example.com>\r\nTo: olivia@acme.com\r\nSubject: Autumn sale\r\nMessage-ID: <autumn@shop>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`;
  const st = await page.evaluate(async (b) => (await fetch('/api/mail/messages/upload?folder=INBOX', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'message/rfc822' }, body: b })).status, eml);
  if (st >= 300) throw new Error(`upload ${st}`);
  await page.goto(`${B}/mail/INBOX`);
  await page.locator('.msg-subject', { hasText: 'Autumn sale' }).first().click();
  const frame = page.frameLocator('iframe.mail-html');
  await frame.getByText('Our autumn sale!').waitFor();
  await page.getByText('Images from the internet are hidden to protect your privacy.').waitFor();
  await page.waitForTimeout(800);
  if (seen.length) throw new Error(`fetched before asked: ${JSON.stringify(seen)}`);
  await page.getByRole('button', { name: 'Show images' }).click();
  await until(async () => seen.length >= 2, 15000);
  for (const s of seen) {
    if (!/Workspace image proxy/.test(s.ua) || s.cookie || s.referer) throw new Error(`not from the server: ${JSON.stringify(s)}`);
  }
  await until(() => frame.getByRole('img', { name: 'Banner' }).evaluate((img) => img.complete && img.naturalWidth > 0), 15000);
  const src = await frame.getByRole('img', { name: 'Banner' }).getAttribute('src');
  if (!src.startsWith('/api/mail/image?')) throw new Error(src);
  const href = await frame.getByRole('link', { name: 'Shop now' }).getAttribute('href');
  if (href !== 'https://shop.example.com/sale') throw new Error(`link changed: ${href}`);
  await page.screenshot({ path: `${SP}/shots/imageproxy.png` });
  await axe(page, 'image proxy');
});
await step('the proxy only serves addresses signed for you', async () => {
  const forged = await page.evaluate(async (u) => (await fetch(`/api/mail/image?u=${encodeURIComponent(u)}&s=abc`)).status, `${PIC}/secret.png`);
  if (forged !== 403) throw new Error(`forged: ${forged}`);
});
await step('a reply quotes the email as it was sent, not the rewritten addresses', async () => {
  await page.locator('.mail-reader').getByRole('button', { name: 'Reply', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Message' });
  await editor.waitFor();
  await until(async () => (await editor.innerHTML()).includes('autumn'));
  const html = await editor.innerHTML();
  if (/\/api\/mail\/image/.test(html)) throw new Error('rewritten address in the reply');
});
pics.close();
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
