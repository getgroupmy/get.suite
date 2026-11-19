// Signed out on another device ("Sign out other devices", or an admin): an open document notices at once,
// without waiting for the next save, and shows sign-in. What was typed before is in the document.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let doc;
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
  doc = (await api('POST', '/files/new', { kind: 'doc', name: 'Live plans' })).body;
});

await step('signed out elsewhere: the open document shows sign-in by itself, and kept what was typed', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  const ed = page.locator('.ProseMirror').first();
  await ed.click();
  await page.keyboard.type('Written before the sign-out.');
  await page.waitForTimeout(2500); // synced
  // The same person, on another computer, signs out every other device.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  const r = await p2.request.post(`${B}/api/auth/login`, { data: { username: 'olivia@acme.com', password: 'password123' }, headers: { 'x-requested-with': 'nas-workspace' } });
  if (!r.ok()) throw new Error(`second sign-in: ${r.status()}`);
  const out = await p2.request.post(`${B}/api/auth/sessions/sign-out-others`, { headers: { 'x-requested-with': 'nas-workspace' } });
  if (!out.ok()) throw new Error(`sign out others: ${out.status()}`);
  const t0 = Date.now();
  await page.getByLabel(/Password/).first().waitFor({ timeout: 8000 }).catch(() => { throw new Error('the first window still shows the document as if signed in'); });
  console.log(`sign-in shown after ${Date.now() - t0} ms`);
  const saved = await p2.request.get(`${B}/api/files/${doc.id}/content`, { headers: { 'x-requested-with': 'nas-workspace' } });
  const text = JSON.stringify(await saved.json());
  await other.close();
  if (!text.includes('Written before the sign-out')) throw new Error('what was typed isn’t in the document');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
