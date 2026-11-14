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
let kim, ch;
const msg = (p, text) => p.locator('.msg', { hasText: text }).last();
await step('setup: a channel with Kim', async () => {
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
  ch = (await api(page, 'POST', '/chat/channels', { name: 'launch' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'We go live today' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/chat/${ch}`); await msg(p, 'We go live today').waitFor(); }
});
await step('Add a company emoji from the picker', async () => {
  await page.locator('.composer, form').getByRole('button', { name: 'Insert emoji' }).first().click();
  const pop = page.getByRole('dialog', { name: 'Emoji' });
  await pop.getByRole('tab', { name: 'Company' }).click();
  await pop.getByText(/^No company emoji yet/).waitFor();
  await pop.getByRole('button', { name: '＋ Add emoji…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Company emoji' });
  await dlg.getByLabel('Name').fill('Ship It');
  await dlg.getByLabel(/^Picture/).setInputFiles(`${ROOT}/e2e/fixtures/blue.png`);
  await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('.toast', { hasText: ':ship-it: added' }).last().waitFor();
  await dlg.getByRole('list', { name: 'Company emoji' }).getByText(':ship-it:').waitFor();
  const msgs = (await api(page, 'GET', `/chat/channels/${ch}/messages`)).body;
  if (msgs.length !== 1) throw new Error('adding an emoji sent a message');
  await dlg.getByRole('button', { name: 'Done' }).click();
});
await step('Use it in a message: everyone sees the picture', async () => {
  await page.getByLabel('Message', { exact: true }).fill('Released ');
  await page.locator('.composer, form').getByRole('button', { name: 'Insert emoji' }).first().click();
  const pop = page.getByRole('dialog', { name: 'Emoji' });
  await pop.getByRole('searchbox', { name: 'Search emoji' }).fill('ship');
  await pop.getByRole('gridcell', { name: ':ship-it:' }).click();
  if ((await page.getByLabel('Message', { exact: true }).inputValue()) !== 'Released :ship-it:') throw new Error(await page.getByLabel('Message', { exact: true }).inputValue());
  await page.getByLabel('Message', { exact: true }).press('Enter');
  for (const p of [page, kim]) await msg(p, 'Released').locator('img.custom-emoji[alt=":ship-it:"]').waitFor();
  const ok = await kim.locator('.msg img.custom-emoji').first().evaluate((img) => img.complete && img.naturalWidth > 0);
  if (!ok) throw new Error('the picture did not load for Kim');
});
await step('Kim reacts with it', async () => {
  await msg(kim, 'We go live today').hover();
  await msg(kim, 'We go live today').getByRole('button', { name: 'Add a reaction' }).click();
  const pop = kim.getByRole('dialog', { name: 'Emoji' });
  await pop.getByRole('tab', { name: 'Company' }).click();
  await pop.getByRole('gridcell', { name: ':ship-it:' }).click();
  await msg(page, 'We go live today').getByRole('button', { name: ':ship-it: 1: Kim Park' }).locator('img.custom-emoji').waitFor();
  await kim.screenshot({ path: `${SP}/shots/chatemoji.png` });
});
await step('Only whoever added it, or an admin, removes it', async () => {
  await kim.locator('.composer, form').getByRole('button', { name: 'Insert emoji' }).first().click();
  await kim.getByRole('dialog', { name: 'Emoji' }).getByRole('tab', { name: 'Company' }).click();
  await kim.getByRole('button', { name: '＋ Add emoji…' }).click();
  const kd = kim.getByRole('dialog', { name: 'Company emoji' });
  await kd.getByText(':ship-it:').waitFor();
  if (await kd.getByRole('button', { name: 'Remove :ship-it:' }).count()) throw new Error('Kim may not remove it');
  await kd.getByRole('button', { name: 'Done' }).click();
  await page.locator('.composer, form').getByRole('button', { name: 'Insert emoji' }).first().click();
  await page.getByRole('dialog', { name: 'Emoji' }).getByRole('tab', { name: 'Company' }).click();
  await page.getByRole('button', { name: '＋ Add emoji…' }).click();
  await page.getByRole('dialog', { name: 'Company emoji' }).getByRole('button', { name: 'Remove :ship-it:' }).click();
  await page.getByRole('dialog', { name: 'Company emoji' }).getByText(/^No company emoji yet/).waitFor();
  // Gone for Kim too: the message shows the words again.
  await until(async () => (await msg(kim, 'Released').locator('img.custom-emoji').count()) === 0);
  await msg(kim, 'Released').getByText('Released :ship-it:').waitFor();
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
