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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let doc;
await step('send a document for signature: it is locked and says who is to sign', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Lease', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rent is 1000 a month.' }] }] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByText('Rent is 1000 a month.').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send for signature…' }).click();
  const d = page.getByRole('dialog', { name: 'Send for signature' });
  await d.getByLabel('Signers').fill('kim@acme.com, olivia@acme.com');
  await d.getByLabel('Message').fill('Please sign by Friday');
  await d.getByRole('button', { name: 'Send' }).click();
  const banner = page.getByRole('region', { name: 'Signatures' });
  await banner.getByText('0 of 2 signed').waitFor();
  await page.getByRole('region', { name: 'Locked' }).waitFor();
});
await step('Kim signs by drawing, from the link in her notification', async () => {
  const n = await until(async () => (await api(kim, 'GET', '/notifications')).body.items.find((x) => /asked you to sign “Lease”/.test(x.title)));
  await kim.goto(`${B}${n.link}`);
  await kim.getByText('Rent is 1000 a month.').waitFor();
  await kim.getByText('“Please sign by Friday”').waitFor();
  await kim.getByLabel('Your full name').fill('Kim Park');
  await kim.getByLabel('Draw your signature').scrollIntoViewIfNeeded();
  const c = await kim.getByLabel('Draw your signature').boundingBox();
  await kim.mouse.move(c.x + 20, c.y + 80); await kim.mouse.down();
  for (let i = 1; i <= 12; i++) await kim.mouse.move(c.x + 20 + i * 25, c.y + 80 + (i % 2 ? -30 : 20));
  await kim.mouse.up();
  const sign = kim.getByRole('button', { name: 'Sign', exact: true });
  if (await sign.isEnabled()) throw new Error('needs the agreement ticked');
  await kim.getByLabel(/I agree to sign this document electronically/).check();
  await sign.click();
  await kim.getByText(/You signed this/).waitFor();
}, kim);
await step('Olivia signs by typing; then it is signed by everyone, with the record', async () => {
  await page.reload();
  const banner = page.getByRole('region', { name: 'Signatures' });
  await banner.getByText('1 of 2 signed').waitFor();
  await banner.getByRole('link', { name: 'Sign now' }).click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Your typed signature').getByText('Olivia Owner').waitFor();
  await page.getByLabel(/I agree to sign this document electronically/).check();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByText(/You signed this.*Everyone has signed/).waitFor();
  await page.goto(`${B}/docs/${doc.id}`);
  await banner.getByText('Signed by everyone').waitFor();
  await banner.getByRole('button', { name: 'Signature record' }).click();
  const rec = page.getByRole('dialog', { name: 'Signatures: Lease' });
  await rec.getByRole('img', { name: 'Signature of Kim Park' }).waitFor();
  await rec.locator('.sign-typed', { hasText: 'Olivia Owner' }).waitFor();
  await rec.getByText(/Document fingerprint \(SHA-256\): [0-9a-f]{64}/).waitFor();
});
await step('signing in order: Kim waits for Olivia, then is asked', async () => {
  const d2 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Ordered' })).body;
  await page.goto(`${B}/docs/${d2.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send for signature…' }).click();
  const d = page.getByRole('dialog', { name: 'Send for signature' });
  await d.getByLabel('Signers').fill('olivia@acme.com, kim@acme.com');
  await d.getByLabel(/One after another/).check();
  await d.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('region', { name: 'Signatures' }).getByText(/Out for signature in order/).waitFor();
  const kimSign = (await api(kim, 'GET', '/signatures')).body.waiting.find((x) => x.title === 'Ordered');
  if (kimSign) throw new Error('Kim asked before her turn');
  await page.getByRole('region', { name: 'Signatures' }).getByRole('link', { name: 'Sign now' }).click();
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel(/I agree to sign/).check();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await page.getByText(/You signed this/).waitFor();
  const w = await until(async () => (await api(kim, 'GET', '/signatures')).body.waiting.find((x) => x.title === 'Ordered'));
  await kim.goto(`${B}${w.link}`);
  await kim.getByLabel('Your full name').waitFor();
}, page);
await step('printing the signed document adds its signatures page', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('region', { name: 'Signatures' }).getByText('Signed by everyone').waitFor();
  await page.emulateMedia({ media: 'print' });
  const sec = page.locator('.signed-print');
  await until(async () => (await sec.isVisible()) && /Kim Park/.test(await sec.innerText()) && /SHA-256/.test(await sec.innerText()));
  await page.emulateMedia({ media: 'screen' });
  if (await sec.isVisible()) throw new Error('shown on screen');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
