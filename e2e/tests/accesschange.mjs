// Access changed while a document is open: Bob is editing; the owner makes him a viewer, so his window
// becomes read-only by itself (his typing isn't taken); then she stops sharing it, and his window says he
// needs access.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const owner = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const bob = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
for (const p of [owner, bob]) p.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await bob.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let doc, bobId;

await step('setup', async () => {
  await owner.goto(B);
  await owner.getByLabel('Your company name').fill('Acme Trading');
  await owner.getByLabel('Company domain').fill('acme.com');
  await owner.getByLabel('Your full name').fill('Olivia Owner');
  await owner.getByLabel('Address before @').fill('olivia');
  await owner.getByLabel('Password', { exact: true }).fill('password123');
  await owner.getByLabel('Confirm password').fill('password123');
  await owner.getByRole('button', { name: 'Create workspace' }).click();
  await owner.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  bobId = (await api(owner, 'POST', '/users', { local: 'bob', domain: 'acme.com', name: 'Bob Brown', password: 'password123' })).body.id;
  doc = (await api(owner, 'POST', '/files/new', { kind: 'doc', name: 'Shared plans' })).body;
  const r = await api(owner, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: bobId, role: 'editor' }] });
  if (r.status !== 200) throw new Error(`share: ${r.status}`);
  await bob.goto(B);
  await bob.getByLabel(/Email/).first().fill('bob@acme.com');
  await bob.getByLabel(/Password/).first().fill('password123');
  await bob.getByRole('button', { name: /Sign in/ }).click();
  await bob.waitForTimeout(2000);
  await bob.goto(`${B}/docs/${doc.id}`);
  const ed = bob.locator('.ProseMirror').first();
  await ed.click();
  await bob.keyboard.type('Bob was here.');
  await bob.waitForTimeout(2000);
});

await step('made a viewer: his open window turns read-only by itself', async () => {
  await api(owner, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: bobId, role: 'viewer' }] });
  const ed = bob.locator('.ProseMirror').first();
  await bob.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'false', null, { timeout: 10000 })
    .catch(() => { throw new Error('his document can still be typed in'); });
  await ed.click();
  await bob.keyboard.type(' Sneaky edit.');
  await bob.waitForTimeout(1500);
  const text = JSON.stringify((await api(owner, 'GET', `/files/${doc.id}/content`)).body);
  if (!text.includes('Bob was here')) throw new Error('his earlier writing is missing');
  if (text.includes('Sneaky edit')) throw new Error('a viewer’s typing was saved');
});

await step('unshared: his window says he needs access', async () => {
  await api(owner, 'PUT', `/files/${doc.id}/shares`, { shares: [] });
  await bob.getByRole('heading', { name: 'You need access' }).waitFor({ timeout: 10000 })
    .catch(() => { throw new Error('his window still shows the document'); });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
