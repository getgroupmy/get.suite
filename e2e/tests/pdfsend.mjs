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
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const chip = (p, t) => p.locator('.chip', { hasText: t });
const { PDFDocument } = (await import('module')).createRequire(`${ROOT}/server/package.json`)('pdf-lib');
let kim;
const pdf = async (n) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([595, 842]); return Buffer.from(await d.save()).toString('base64'); };
const upload = (p, name, b64) => p.evaluate(async ([n, d]) => {
  const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
  return (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: bytes })).json();
}, [name, b64]);
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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await upload(page, 'Lease.pdf', await pdf(2));
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Lease.pdf').waitFor();
});
await step('Olivia sends the PDF to Kim to sign', async () => {
  await page.getByLabel('Actions for Lease.pdf').click();
  await page.getByRole('menuitem', { name: 'Send for signature…' }).click();
  const d = page.getByRole('dialog', { name: 'Send for signature' });
  await d.getByLabel('Signers').fill('kim@acme.com');
  await d.getByLabel('Message').fill('The lease, please');
  await d.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to 1 person to sign').waitFor();
});
await step('Kim opens it from Drive → Signatures: the PDF itself shows; Kim signs', async () => {
  await kim.goto(`${B}/drive/signatures`);
  await kim.getByRole('link', { name: 'Sign', exact: true }).first().click();
  await kim.getByText('“The lease, please”').waitFor();
  await until(async () => (await kim.locator('.pdf-pages-page[data-ready]').count()) === 2, 20000);
  await kim.getByLabel('Your full name').fill('Kim Park');
  await kim.getByLabel('Draw your signature').scrollIntoViewIfNeeded();
  const c = await kim.getByLabel('Draw your signature').boundingBox();
  await kim.mouse.move(c.x + 20, c.y + 80); await kim.mouse.down();
  for (let i = 1; i <= 12; i++) await kim.mouse.move(c.x + 20 + i * 25, c.y + 80 + (i % 2 ? -30 : 20));
  await kim.mouse.up();
  await kim.getByLabel(/I agree to sign this document electronically/).check();
  await kim.screenshot({ path: `${SP}/shots/pdf-send-sign.png` });
  await kim.getByRole('button', { name: 'Sign', exact: true }).click();
  await kim.getByText(/You signed this/).waitFor();
});
await step('Olivia finds the signed PDF beside it, with a Signatures page', async () => {
  await page.goto(`${B}/drive/signatures`);
  await page.getByRole('link', { name: 'Lease (signed).pdf' }).waitFor();
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Lease (signed).pdf').waitFor();
  const list = (await api(page, 'GET', '/files')).body;
  const f = (list.files || list).find((x) => x.name === 'Lease (signed).pdf');
  const b64 = await page.evaluate(async (i) => { const a = new Uint8Array(await (await fetch(`/api/files/${i}/raw`)).arrayBuffer()); let s = ''; for (const x of a) s += String.fromCharCode(x); return btoa(s); }, f.id);
  const n = (await PDFDocument.load(Buffer.from(b64, 'base64'))).getPageCount();
  if (n !== 3) throw new Error(`${n} pages`);
  const bell = JSON.stringify((await api(page, 'GET', '/notifications')).body);
  if (!bell.includes('Everyone has signed “Lease.pdf”')) throw new Error('told');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
