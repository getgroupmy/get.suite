import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
// e2e-env: MAIL_DNS_SERVERS=127.0.0.1:5353
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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
// A pretend DNS server: mail.acme.com is 198.51.100.7 (a public test address), SpamCop lists it, the rest don't.
const dgram = await import('node:dgram');
const dnsServer = dgram.createSocket('udp4');
const answers = { 'mail.acme.com': '198.51.100.7', '7.100.51.198.bl.spamcop.net': '127.0.0.2' };
dnsServer.on('message', (msg, rinfo) => {
  let i = 12; const labels = [];
  while (msg[i]) { labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString()); i += msg[i] + 1; }
  const qEnd = i + 5, name = labels.join('.').toLowerCase(), qtype = msg.readUInt16BE(i + 1);
  const ip = qtype === 1 ? answers[name] : null;
  const head = Buffer.alloc(12); msg.copy(head, 0, 0, 2);
  head.writeUInt16BE(ip ? 0x8180 : 0x8183, 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(ip ? 1 : 0, 6);
  const question = msg.subarray(12, qEnd);
  const ans = ip ? Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]), Buffer.from(ip.split('.').map(Number))]) : Buffer.alloc(0);
  dnsServer.send(Buffer.concat([head, question, ans]), rinfo.port, rinfo.address);
});
await new Promise((r) => dnsServer.bind(5353, '127.0.0.1', r));
await step('Admin → Email: the blocklist check shows a listing, with where to ask to be removed', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Email' }).click();
  const card = page.getByRole('heading', { name: 'Spam blocklists' }).locator('xpath=ancestor::div[contains(@class, "card")]');
  await card.getByRole('button', { name: 'Check blocklists' }).click();
  const ip = card.getByRole('region', { name: 'Blocklists for 198.51.100.7' });
  await ip.getByText(/on 1 list/).waitFor({ timeout: 30000 });
  const spamcop = ip.locator('li', { hasText: 'SpamCop' });
  await spamcop.getByText('✗ Listed (127.0.0.2)').waitFor();
  if ((await spamcop.getByRole('link', { name: 'Ask to be removed' }).getAttribute('href')) !== 'https://www.spamcop.net/bl.shtml') throw new Error('removal link');
  await ip.locator('li', { hasText: 'Spamhaus ZEN' }).getByText('✓ Not listed').waitFor();
  await page.screenshot({ path: `${SP}/shots/blocklists.png` });
});
await step('Admin → System lists it among the health checks', async () => {
  await page.goto(`${B}/admin?tab=system`);
  const item = page.getByRole('list', { name: 'Checks' }).getByRole('listitem', { name: 'Spam blocklists' });
  await item.getByText(/198\.51\.100\.7 on SpamCop: mail from it may be refused/).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${SP}/shots/blocklists-health.png` });
});
await step('…and the mail DNS records: this DNS has none for the company domain', async () => {
  const item = page.getByRole('list', { name: 'Checks' }).getByRole('listitem', { name: 'Mail DNS records' });
  await item.getByText(/acme\.com: MX, SPF, DKIM, DMARC.* not right.*Check DNS shows what to set/).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${SP}/shots/maildns-health.png` });
});
dnsServer.close();
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
