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

const clickAt = async (p, scope, n, fx, fy) => {
  const box = scope.getByRole('group', { name: `Page ${n}`, exact: true });
  for (let k = 0; k < 40; k++) { const b = await box.boundingBox(); const y = b.y + b.height * fy; if (y > 180 && y < 700) break; await p.mouse.move(b.x + 10, 400); await p.mouse.wheel(0, y >= 700 ? 150 : -150); await p.waitForTimeout(50); }
  const b = await box.boundingBox(); await p.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
};
await step('Olivia places a signature box and a date box for Kim, then sends', async () => {
  await page.getByLabel('Actions for Lease.pdf').click();
  await page.getByRole('menuitem', { name: 'Send for signature…' }).click();
  const d = page.getByRole('dialog', { name: 'Send for signature' });
  await d.getByLabel('Signers').fill('kim@acme.com');
  await d.getByRole('button', { name: 'Place where they sign…' }).click();
  const w = page.getByRole('dialog', { name: 'Where they sign' });
  await until(async () => (await w.locator('.pdf-pages-page[data-ready]').count()) === 2, 20000);
  await w.getByLabel('Box', { exact: true }).selectOption('signature');
  await clickAt(page, w, 2, 0.7, 0.8);
  await w.getByLabel('Box', { exact: true }).selectOption('date');
  await clickAt(page, w, 2, 0.7, 0.9);
  await w.getByLabel('Signature: kim@acme.com', { exact: true }).waitFor();
  await w.getByLabel('Date: kim@acme.com', { exact: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/pdf-boxes.png` });
  await w.getByRole('button', { name: 'Done' }).click();
  await d.getByText('2 boxes placed').waitFor();
  await d.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to 1 person to sign').waitFor();
});
await step('Kim sees where to sign, and signs', async () => {
  await kim.goto(`${B}/drive/signatures`);
  await kim.getByRole('link', { name: 'Sign', exact: true }).first().click();
  await kim.getByLabel('Your signature goes here', { exact: true }).waitFor({ timeout: 20000 });
  await kim.getByLabel('Your full name').fill('Kim Park');
  await kim.getByLabel('Draw your signature').scrollIntoViewIfNeeded();
  const c = await kim.getByLabel('Draw your signature').boundingBox();
  await kim.mouse.move(c.x + 20, c.y + 80); await kim.mouse.down();
  for (let i = 1; i <= 12; i++) await kim.mouse.move(c.x + 20 + i * 25, c.y + 80 + (i % 2 ? -30 : 20));
  await kim.mouse.up();
  await kim.getByLabel(/I agree to sign this document electronically/).check();
  await kim.getByRole('button', { name: 'Sign', exact: true }).click();
  await kim.getByText(/You signed this/).waitFor();
});
await step('the signed PDF has Kim\'s signature in the box', async () => {
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for Lease (signed).pdf').click();
  await page.getByRole('menuitem', { name: 'Fill & sign…' }).click();
  await until(async () => (await page.locator('.pdf-sign-page canvas[data-ready]').count()) >= 3, 20000);
  const inkNear = (i, fx, fy) => page.evaluate(([i, fx, fy]) => {
    const c = document.querySelectorAll('.pdf-sign-page canvas')[i - 1], g = c.getContext('2d');
    const w = Math.round(c.width * 0.2), h = Math.round(c.height * 0.05);
    const { data } = g.getImageData(Math.round(c.width * fx - w / 2), Math.round(c.height * fy - h / 2), w, h);
    let n = 0; for (let k = 0; k < data.length; k += 4) if (data[k] < 120 && data[k + 2] > 60 && data[k + 3] > 0) n++;
    return n;
  }, [i, fx, fy]);
  const there = await inkNear(2, 0.7, 0.8), date = await inkNear(2, 0.7, 0.9), not = await inkNear(1, 0.7, 0.8);
  if (there < 20 || date < 5 || not > 0) throw new Error(`ink ${there} / date ${date} / page 1 ${not}`);
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
