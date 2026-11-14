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
const main = (p) => p.locator('.chat-main');
const thread = (p) => p.getByRole('complementary', { name: 'Thread' });
const msg = (scope, text) => scope.locator('.msg', { hasText: text }).last();
await step('setup: a channel with two people in it', async () => {
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
  ch = (await api(page, 'POST', '/chat/channels', { name: 'planning' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Offsite in March or April?' });
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Also: the budget is due Friday' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/chat/${ch}`); await msg(main(p), 'Offsite in March').waitFor(); }
});
let other;
await step('type @ to pick someone; Enter picks instead of sending', async () => {
  other = (await api(page, 'POST', '/chat/channels', { name: 'random' })).body.id;
  await kim.goto(`${B}/chat/${other}`);
  await kim.getByLabel('Message', { exact: true }).waitFor();
  await main(page).getByLabel('Message', { exact: true }).click();
  await page.keyboard.type('Thanks @ki');
  await page.getByRole('listbox', { name: 'People to mention' }).getByRole('option', { name: /Kim Park/ }).waitFor();
  await page.keyboard.press('Enter');
  const v = await main(page).getByLabel('Message', { exact: true }).inputValue();
  if (v !== 'Thanks @kim@acme.com ') throw new Error(JSON.stringify(v));
  await page.keyboard.type('for the slides');
  await page.keyboard.press('Enter');
  await msg(main(page), 'for the slides').locator('.mention', { hasText: '@kim@acme.com' }).waitFor();
});
await step('the person mentioned gets a notice and an @ on the conversation', async () => {
  await kim.locator('.toast', { hasText: 'Olivia Owner mentioned you: Thanks @kim@acme.com for the slides' }).waitFor();
  await kim.locator('.subnav-item', { hasText: 'planning' }).getByLabel('You were mentioned').waitFor();
  await kim.locator('.toast').getByRole('button', { name: 'Open' }).click();
  await msg(main(kim), 'for the slides').locator('.mention.me').waitFor();
  await kim.locator('.subnav-item', { hasText: 'planning' }).getByLabel('You were mentioned').waitFor({ state: 'detached' });
  await kim.screenshot({ path: `${SP}/shots/mention.png` });
});
await step('the @ survives a reload until the conversation is read', async () => {
  await kim.locator('.subnav-item', { hasText: 'random' }).click();
  await kim.waitForTimeout(500);
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: '@kim@acme.com one more thing' });
  await kim.locator('.subnav-item', { hasText: 'planning' }).getByLabel('You were mentioned').waitFor();
  await kim.reload();
  await kim.locator('.subnav-item', { hasText: 'planning' }).getByLabel('You were mentioned').waitFor();
  await kim.locator('.subnav-item', { hasText: 'planning' }).click();
  await kim.locator('.subnav-item', { hasText: 'planning' }).getByLabel('You were mentioned').waitFor({ state: 'detached' });
});
await step('mentions work in thread replies too', async () => {
  await msg(main(page), 'Offsite in March').hover();
  await msg(main(page), 'Offsite in March').getByRole('button', { name: 'Reply in thread' }).click();
  await thread(page).getByLabel('Reply', { exact: true }).click();
  await page.keyboard.type('@kim');
  await thread(page).getByRole('option', { name: /Kim Park/ }).click();
  await page.keyboard.type('what do you think?');
  await page.keyboard.press('Enter');
  await kim.locator('.toast', { hasText: 'mentioned you: @kim@acme.com what do you think?' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
