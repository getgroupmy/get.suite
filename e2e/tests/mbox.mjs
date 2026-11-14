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
const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
const subject = `Quarterly figures ${Date.now()}`;
await step('email is in Download your data, as an .mbox per folder', async () => {
  await until(async () => (await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: 'Here are the figures.' })).status === 200, 60000);
  await until(async () => ((await api(page, 'GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent(subject)}`)).body?.messages || []).length > 0, 60000);
  const ru = await api(page, 'PUT', '/mail/rules', { rules: [{ name: 'Receipts', enabled: true, match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'receipt' }], actions: { moveTo: 'Receipts' } }] });
  if (ru.status !== 200) throw new Error(`rules ${ru.status} ${JSON.stringify(ru.body)}`);
  const sg = await api(page, 'PUT', '/mail/signatures/olivia@acme.com', { html: '<p>Olivia, Acme Trading</p>' });
  const mt = await api(page, 'POST', '/mail/templates', { name: 'Welcome', subject: 'Welcome aboard', html: '<p>Glad to have you.</p>' });
  if (mt.status !== 201) throw new Error(`template ${mt.status} ${JSON.stringify(mt.body)}`);
  if (sg.status !== 200) throw new Error(`signature ${sg.status} ${JSON.stringify(sg.body)}`);
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Download your data' });
  await card.getByText(/\d+ emails?/).waitFor({ timeout: 30000 });
  await card.getByText(/your email \(an \.mbox file for each folder/).waitFor();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/takeout-mail.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), card.getByRole('link', { name: /Download your data/ }).click()]);
  await dl.saveAs(`${SP}/takeout.zip`);
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(`${SP}/takeout.zip`));
  const box = await zip.file('Mail/Inbox.mbox')?.async('string');
  if (!box || !box.includes(`Subject: ${subject}`) || !/^From \S+ \w{3} \w{3}/.test(box)) throw new Error(Object.keys(zip.files).join(', '));
  if (!zip.file('Mail/Sent.mbox')) throw new Error('no Sent');
  const sieve = await zip.file('Mail settings/filters.sieve')?.async('string');
  if (!sieve || !/receipt/.test(sieve) || !/fileinto/.test(sieve)) throw new Error(`filters: ${sieve}`);
  const sig = await zip.file('Mail settings/signature olivia@acme.com.html')?.async('string');
  const tpl = await zip.file('Mail settings/templates/Welcome.html')?.async('string');
  if (!tpl || !tpl.includes('<title>Welcome aboard</title>') || !tpl.includes('Glad to have you.')) throw new Error(`template: ${tpl}`);
  if (sig !== '<p>Olivia, Acme Trading</p>') throw new Error(`signature: ${sig} in ${Object.keys(zip.files).filter((n) => n.startsWith('Mail settings')).join(', ')}`);
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
