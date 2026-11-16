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
// Styles meant for one screen that once leaked into another through a shared class name.
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
await step('Admin → Storage: the company bar spans the card (not the room-usage table’s 60 px bar)', async () => {
  if ((await api(page, 'PATCH', '/orgs/current', { quota_mb: 1000 })).status !== 200) throw new Error('quota not set');
  await page.goto(`${B}/admin?tab=storage`);
  const bar = page.locator('.usage-bar').first();
  await bar.waitFor();
  const w = await bar.evaluate((el) => el.getBoundingClientRect().width);
  if (w < 300) throw new Error(`bar only ${w}px wide`);
});
await step('Chat: attachments sit under the message text, without the Mail list’s indent', async () => {
  const ch = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => !c.dm_key);
  await page.goto(`${B}/chat/${ch.id}`);
  await page.getByLabel('Message', { exact: true }).waitFor();
  await page.getByLabel('Files to attach').setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('agenda') }]);
  await page.getByRole('list', { name: 'Files to send' }).getByText('notes.txt').waitFor();
  await page.getByLabel('Message', { exact: true }).fill('Here are the notes');
  await page.keyboard.press('Enter');
  const files = page.locator('.msg', { hasText: 'Here are the notes' }).last().locator('.msg-files');
  await files.waitFor();
  const look = await files.evaluate((el) => { const c = getComputedStyle(el); return { pad: c.paddingLeft, top: c.marginTop }; });
  if (look.pad !== '0px' || look.top !== '6px') throw new Error(JSON.stringify(look));
});
await step('the top bar’s Account button keeps its padding and is centred in the bar (not Chat’s avatar style)', async () => {
  await page.goto(`${B}/chat`);
  const btn = page.getByRole('button', { name: 'Account' });
  await btn.waitFor();
  const look = await btn.evaluate((el) => { const c = getComputedStyle(el); const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect(); return { pad: c.paddingTop, off: Math.abs((r.top + r.bottom) / 2 - (p.top + p.bottom) / 2) }; });
  if (look.pad !== '4px' || look.off > 2) throw new Error(JSON.stringify(look));
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
