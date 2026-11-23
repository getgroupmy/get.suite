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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);

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

const until = async (fn, ms = 8000) => { for (let end = Date.now() + ms; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
const ids = {};
await step('eight conversations; the latest message is in #zeta', async () => {
  for (const n of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']) ids[n] = (await api(page, 'POST', '/chat/channels', { name: n })).body.id;
  for (const n of ['alpha', 'gamma', 'zeta']) { await api(page, 'POST', `/chat/channels/${ids[n]}/messages`, { body: `hello ${n}` }); await page.waitForTimeout(30); }
});
await step('Send in Chat…: the latest conversation is first and chosen; Find a conversation narrows the list', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Pricing memo' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send in Chat…' }).click();
  const d = page.getByRole('dialog', { name: 'Send the document in Chat' });
  const sel = d.getByLabel('Conversation');
  await until(async () => (await sel.locator('option').count()) >= 8);
  const opts = await sel.locator('option').allInnerTexts();
  if (opts.slice(0, 3).join(',') !== '# zeta,# gamma,# alpha') throw new Error(opts.join(','));
  if ((await sel.inputValue()) !== ids.zeta) throw new Error('not chosen: ' + await sel.inputValue());
  await d.getByLabel('Find by name').fill('BET');
  await until(async () => (await sel.locator('option').allInnerTexts()).join(',') === '# beta');
  if ((await sel.inputValue()) !== ids.beta) throw new Error('beta not chosen');
  await d.getByLabel('Find by name').fill('nothing like it');
  await d.getByText('No conversation is called that.').waitFor();
  if (!(await d.getByRole('button', { name: 'Open in Chat' }).isDisabled())) throw new Error('can open with none chosen');
  await d.getByLabel('Find by name').fill('bet');
  await d.getByRole('button', { name: 'Open in Chat' }).click();
  await page.waitForURL(`**/chat/${ids.beta}`);
  const box = page.getByLabel('Message', { exact: true });
  await until(async () => (await box.inputValue()).includes(`/docs/${doc.id}`));
});

await step('Forward: the latest other conversation is chosen, and Find by name narrows the list', async () => {
  await page.goto(`${B}/chat/${ids.zeta}`);
  const msg = page.locator('.msg', { hasText: 'hello zeta' });
  await msg.hover();
  await msg.getByRole('button', { name: 'Forward' }).click();
  const d = page.getByRole('dialog', { name: 'Forward message' });
  const sel = d.getByLabel('To');
  const opts = await sel.locator('option').allInnerTexts();
  if (opts.slice(0, 3).join(',') !== '# zeta,# gamma,# alpha') throw new Error(opts.join(','));
  if ((await sel.inputValue()) !== ids.gamma) throw new Error('not the latest other one: ' + await sel.inputValue());
  await d.getByLabel('Find by name').fill('epsi');
  await until(async () => (await sel.locator('option').allInnerTexts()).join(',') === '# epsilon');
  await d.getByRole('button', { name: 'Forward' }).click();
  await d.waitFor({ state: 'detached' });
  await until(async () => { const b = (await api(page, 'GET', `/chat/channels/${ids.epsilon}/messages`)).body; return (Array.isArray(b) ? b : b.messages || []).some((m) => m.forwarded?.body === 'hello zeta'); });
});
await step('Contacts → Send in Chat…: the latest conversations first, and Find by name narrows the list', async () => {
  const c = (await api(page, 'POST', '/contacts', { name: 'Ann Able', emails: [{ value: 'ann@example.com' }] })).body;
  if (!c?.id) throw new Error('contact ' + JSON.stringify(c));
  await page.goto(`${B}/contacts`);
  await page.getByLabel('Select Ann Able').check();
  await page.getByRole('toolbar', { name: 'Change the selected contacts' }).getByRole('button', { name: 'Send in Chat…' }).click();
  const d = page.getByRole('dialog', { name: 'Send Ann Able in Chat' });
  const sel = d.getByLabel('To');
  const opts = await sel.locator('option').allInnerTexts();
  if (opts.slice(0, 2).join(',') !== '# epsilon,# zeta') throw new Error(opts.join(','));
  await d.getByLabel('Find by name').fill('gam');
  await until(async () => (await sel.locator('option').allInnerTexts()).join(',') === '# gamma');
  await d.getByRole('button', { name: 'Send' }).click();
  await page.locator('.toast', { hasText: 'Ann Able sent to # gamma' }).waitFor();
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
