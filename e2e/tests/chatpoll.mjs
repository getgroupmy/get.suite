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
let ch, kim;
await step('setup: a channel and a colleague', async () => {
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
  ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Morning all' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/chat/${ch}`); await p.getByText('Morning all').waitFor(); }
});
const poll = (p) => p.getByRole('group', { name: 'Poll: Where shall we have lunch?' });
await step('create a poll with three options (one blank option is dropped)', async () => {
  await page.getByRole('button', { name: 'Create a poll' }).click();
  const dlg = page.getByRole('dialog', { name: 'Create a poll' });
  await dlg.getByLabel('Question').fill('Where shall we have lunch?');
  await dlg.getByLabel('Option 1', { exact: true }).fill('Pizza');
  await dlg.getByLabel('Option 2', { exact: true }).fill('Sushi');
  await dlg.getByRole('button', { name: '+ Add an option' }).click();
  await dlg.getByLabel('Option 3', { exact: true }).fill('Salad');
  await dlg.getByRole('button', { name: '+ Add an option' }).click();
  await dlg.getByRole('button', { name: 'Post poll' }).click();
  await poll(page).waitFor();
  await poll(kim).waitFor();
  if (await poll(page).getByRole('button', { name: /: 0 votes$/ }).count() !== 3) throw new Error('three options');
});
await step('Kim votes; Olivia sees it live with the name; Kim changes their mind', async () => {
  await poll(kim).getByRole('button', { name: 'Sushi: 0 votes' }).click();
  await poll(page).getByRole('button', { name: 'Sushi: 1 vote' }).waitFor();
  await poll(page).getByText('Kim Park').waitFor();
  await poll(page).getByText('1 person voted').waitFor();
  await poll(page).getByRole('button', { name: 'Sushi: 1 vote' }).click();
  await poll(kim).getByRole('button', { name: 'Sushi: 2 votes' }).waitFor();
  await poll(kim).getByRole('button', { name: 'Pizza: 0 votes' }).click();
  await poll(page).getByRole('button', { name: 'Pizza: 1 vote' }).waitFor();
  await poll(page).getByRole('button', { name: 'Sushi: 1 vote' }).waitFor();
  if ((await poll(kim).getByRole('button', { name: 'Pizza: 1 vote' }).getAttribute('aria-pressed')) !== 'true') throw new Error('marked as mine');
  await page.screenshot({ path: `${SP}/shots/chat-poll.png` });
});
await step('a poll cannot be edited; only who asked closes it, and then nobody votes', async () => {
  const msg = page.locator('.msg', { has: poll(page) });
  await msg.hover();
  if (await msg.getByRole('button', { name: 'Edit message' }).count()) throw new Error('edit shown');
  if (await poll(kim).getByRole('button', { name: 'Close poll' }).count()) throw new Error('Kim can close');
  await poll(page).getByRole('button', { name: 'Close poll' }).click();
  await poll(kim).getByText(/^Closed ·/).waitFor();
  if (!(await poll(kim).getByRole('button', { name: 'Salad: 0 votes' }).isDisabled())) throw new Error('still open');
  await poll(page).getByRole('button', { name: 'Reopen poll' }).click();
  await poll(kim).getByText(/^Choose one ·/).waitFor();
});
await step('a poll allowing several choices', async () => {
  await page.getByRole('button', { name: 'Create a poll' }).click();
  const dlg = page.getByRole('dialog', { name: 'Create a poll' });
  await dlg.getByLabel('Question').fill('Which days work?');
  await dlg.getByLabel('Option 1', { exact: true }).fill('Mon');
  await dlg.getByLabel('Option 2', { exact: true }).fill('Tue');
  await dlg.getByLabel('People can choose more than one').check();
  await dlg.getByRole('button', { name: 'Post poll' }).click();
  const p2 = kim.getByRole('group', { name: 'Poll: Which days work?' });
  await p2.getByText(/^Choose any/).waitFor();
  await p2.getByRole('button', { name: 'Mon: 0 votes' }).click();
  await p2.getByRole('button', { name: 'Mon: 1 vote' }).waitFor();
  await p2.getByRole('button', { name: 'Tue: 0 votes' }).click();
  await p2.getByRole('button', { name: 'Tue: 1 vote' }).waitFor();
  await p2.getByRole('button', { name: 'Mon: 1 vote' }).waitFor();
});
await step('a poll with one option is refused in the dialog', async () => {
  await page.getByRole('button', { name: 'Create a poll' }).click();
  const dlg = page.getByRole('dialog', { name: 'Create a poll' });
  await dlg.getByLabel('Question').fill('Really?');
  await dlg.getByLabel('Option 1', { exact: true }).fill('Yes');
  await dlg.getByRole('button', { name: 'Post poll' }).click();
  await dlg.getByText('A poll needs at least two options').waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
