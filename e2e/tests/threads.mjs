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
await step('reply in a thread: it opens beside the conversation and the reply goes there', async () => {
  await msg(main(kim), 'Offsite in March').hover();
  await msg(main(kim), 'Offsite in March').getByRole('button', { name: 'Reply in thread' }).click();
  await thread(kim).waitFor();
  await thread(kim).getByText('No replies yet').waitFor();
  await thread(kim).getByLabel('Reply', { exact: true }).fill('April, the weather is better');
  await kim.keyboard.press('Enter');
  await msg(thread(kim), 'April, the weather').waitFor();
  await thread(kim).getByText('1 reply', { exact: true }).waitFor();
  if (await main(kim).locator('.msg', { hasText: 'April, the weather' }).count()) throw new Error('replies stay out of the conversation');
});
await step('the other person sees the reply count live, opens the thread and answers', async () => {
  const summary = msg(main(page), 'Offsite in March').locator('.thread-summary');
  await summary.getByText('1 reply').waitFor();
  await summary.click();
  await msg(thread(page), 'April, the weather').waitFor();
  await thread(page).getByLabel('Reply', { exact: true }).fill('April it is');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await msg(thread(kim), 'April it is').waitFor();
  await msg(main(kim), 'Offsite in March').locator('.thread-summary').getByText('2 replies').waitFor();
  await page.screenshot({ path: `${SP}/shots/thread.png` });
});
await step('react and edit inside the thread', async () => {
  await msg(thread(page), 'April, the weather').hover();
  await msg(thread(page), 'April, the weather').getByRole('button', { name: 'React with 👍' }).click();
  await msg(thread(kim), 'April, the weather').getByRole('button', { name: '👍 1: Olivia Owner' }).waitFor();
  await msg(thread(page), 'April it is').hover();
  await msg(thread(page), 'April it is').getByRole('button', { name: 'Edit message' }).click();
  await thread(page).getByLabel('Change the message').fill('April it is, booked');
  await page.keyboard.press('Enter');
  await msg(thread(kim), 'April it is, booked').waitFor();
});
await step('the main conversation still works and has no thread replies', async () => {
  await main(page).getByLabel('Message', { exact: true }).fill('New topic');
  await page.keyboard.press('Enter');
  await msg(main(kim), 'New topic').waitFor();
  const texts = await main(kim).locator('.msg-text').allInnerTexts();
  if (texts.some((t) => /weather|April it is/.test(t))) throw new Error(texts.join(' | '));
});
await step('Escape closes the thread; deleting a reply updates the count', async () => {
  await page.keyboard.press('Escape');
  await thread(page).waitFor({ state: 'detached' });
  await msg(thread(kim), 'April it is, booked').hover();
  if (await msg(thread(kim), 'April it is, booked').getByRole('button', { name: 'Delete message' }).count()) throw new Error("can't delete someone else's");
  await msg(main(page), 'Offsite in March').locator('.thread-summary').click();
  await msg(thread(page), 'April it is, booked').hover();
  await msg(thread(page), 'April it is, booked').getByRole('button', { name: 'Delete message' }).click();
  await msg(thread(kim), 'April it is, booked').waitFor({ state: 'detached' });
  await msg(main(kim), 'Offsite in March').locator('.thread-summary').getByText('1 reply').waitFor();
});
await step('deleting the message keeps its thread: "This message was deleted" for everyone', async () => {
  await msg(main(page), 'Offsite in March').hover();
  await msg(main(page), 'Offsite in March').getByRole('button', { name: 'Delete message' }).click();
  await main(kim).getByText('This message was deleted.').waitFor();
  await main(kim).locator('.msg', { hasText: 'This message was deleted.' }).locator('.thread-summary').getByText('1 reply').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
