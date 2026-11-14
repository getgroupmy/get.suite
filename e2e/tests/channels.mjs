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
let kim, vic;
const side = (p, name) => p.locator('.subnav-item', { hasText: name });
await step('setup: three people', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const [local, name] of [['kim', 'Kim Park'], ['vic', 'Vic Viewer']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/chat`); await side(p, 'general').waitFor(); }
});
await step('a private channel with a topic: only Kim sees it', async () => {
  await page.getByRole('button', { name: 'New channel' }).click();
  const dlg = page.getByRole('dialog', { name: 'New channel' });
  await dlg.getByLabel('Channel name').fill('leadership');
  await dlg.getByLabel('Topic (optional)').fill('Plans before they are announced');
  await dlg.getByLabel(/Private: only/).check();
  await dlg.getByLabel(/Kim Park/).check();
  await dlg.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('heading', { name: '🔒 leadership' }).waitFor();
  await page.getByText('Plans before they are announced').waitFor();
  await page.getByText('2 members').waitFor();
  await side(kim, 'leadership').waitFor();
  await vic.waitForTimeout(800);
  if (await side(vic, 'leadership').count()) throw new Error('Vic should not see it');
  await page.screenshot({ path: `${SP}/shots/private-channel.png` });
});
await step('add Vic from the settings; Kim changes the topic', async () => {
  await page.getByRole('button', { name: 'Channel settings' }).click();
  const dlg = page.getByRole('dialog', { name: '#leadership' });
  await dlg.getByLabel(/Vic Viewer/).check();
  await dlg.getByRole('button', { name: 'Add 1' }).click();
  await dlg.getByText('Members (3)').waitFor();
  await side(vic, 'leadership').waitFor();
  await page.keyboard.press('Escape');
  await side(kim, 'leadership').click();
  await kim.getByRole('button', { name: 'Channel settings' }).click();
  const kd = kim.getByRole('dialog', { name: '#leadership' });
  if (await kd.getByRole('button', { name: 'Archive channel' }).count()) throw new Error('only the maker or an admin can archive');
  await kd.getByLabel('Topic').fill('Plans and hiring');
  await kd.getByRole('button', { name: 'Save topic' }).click();
  await page.getByText('Plans and hiring').waitFor();
  await kim.keyboard.press('Escape');
});
await step('Vic leaves; it is gone from his list', async () => {
  await side(vic, 'leadership').click();
  await vic.getByRole('button', { name: 'Channel settings' }).click();
  await vic.getByRole('dialog', { name: '#leadership' }).getByRole('button', { name: 'Leave' }).click();
  await vic.getByRole('dialog', { name: 'Leave this channel?' }).getByRole('button', { name: 'Leave' }).click();
  await side(vic, 'leadership').waitFor({ state: 'detached' });
});
await step('archive: read-only, and listed apart', async () => {
  await page.getByRole('button', { name: 'Channel settings' }).click();
  await page.getByRole('dialog', { name: '#leadership' }).getByRole('button', { name: 'Archive channel' }).click();
  await page.getByRole('dialog', { name: 'Archive this channel?' }).getByRole('button', { name: 'Archive' }).click();
  await page.getByText('This channel is archived').waitFor();
  if (await page.getByLabel('Message', { exact: true }).count()) throw new Error('no message box when archived');
  await kim.getByText('This channel is archived').waitFor();
  await page.goto(`${B}/chat`);
  await side(page, 'general').waitFor();
  if (await side(page, 'leadership').count()) throw new Error('archived ones are tucked away');
  await page.getByRole('button', { name: 'Show archived (1)' }).click();
  await side(page, 'leadership').click();
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await page.getByLabel('Message', { exact: true }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
