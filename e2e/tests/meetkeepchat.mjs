import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
const max = await mk('max');
let code;
const chat = (p) => p.getByRole('complementary', { name: 'Meeting chat' });
const say = async (p, text) => { await chat(p).getByLabel('Send a message to everyone').fill(text); await chat(p).getByRole('button', { name: 'Send' }).click(); };
await step('both join; chat is not kept to start with', async () => {
  await api(page, 'POST', '/users', { local: 'max', domain: 'acme.com', name: 'Max Meet', password: 'password123' });
  await page.goto(`${B}/meet`);
  await page.getByLabel('Meeting name (optional)').fill('Planning');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.waitForURL(/\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  code = page.url().split('/meet/')[1];
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await signIn(max, 'max@acme.com');
  await max.goto(`${B}/meet/${code}`);
  await max.getByRole('button', { name: 'Join now' }).click();
  await max.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await max.getByRole('button', { name: 'Chat', exact: true }).click();
  await chat(max).getByText('go when it ends').waitFor();
  await say(max, 'Not kept, this one');
});
await step('the host ticks Keep the meeting chat in People; Max is told in the chat', async () => {
  await page.getByRole('button', { name: /^People/ }).click();
  await page.getByLabel('Keep the meeting chat').check();
  await chat(max).getByText('Olivia Owner is keeping this chat').waitFor();
  await chat(max).getByText(/This chat is being kept/).waitFor();
  if (await max.getByLabel('Keep the meeting chat').count()) throw new Error('not for Max');
});
await step('messages from then on are kept', async () => {
  await say(max, 'Budget is approved');
  await page.getByRole('button', { name: /^Chat/ }).click();
  await chat(page).getByText('You are keeping this chat').waitFor();
  await chat(page).getByText('Budget is approved').waitFor();
  await say(page, 'Great, next item');
  await chat(max).getByText('Great, next item').waitFor();
});
await step('after the meeting: Recent meetings → 💬 Chat shows what was kept, and downloads', async () => {
  await max.getByRole('button', { name: 'Leave the meeting' }).click();
  await page.getByRole('button', { name: 'Leave the meeting' }).click();
  await max.goto(`${B}/meet`);
  await max.getByRole('button', { name: 'Chat from Planning' }).click();
  const d = max.getByRole('dialog', { name: 'Chat from Planning' });
  const items = await d.getByRole('list', { name: 'Kept chat' }).locator('li').allInnerTexts();
  if (items.length !== 2 || !/^Max Meet[\s\S]*Budget is approved$/.test(items[0]) || !/^Olivia Owner[\s\S]*Great, next item$/.test(items[1])) throw new Error(JSON.stringify(items));
  const href = await d.getByRole('link', { name: 'Download (.txt)' }).getAttribute('href');
  const txt = await max.evaluate(async (h) => (await fetch(h)).text(), href);
  if (!/Max Meet: Budget is approved/.test(txt) || /Not kept/.test(txt)) throw new Error(txt);
}, max);
await step('Max, who was in it, cannot delete it', async () => {
  const d = max.getByRole('dialog', { name: 'Chat from Planning' });
  await d.getByRole('link', { name: 'Download (.txt)' }).waitFor();
  if (await d.getByRole('button', { name: 'Delete chat' }).count()) throw new Error('shown to Max');
}, max);
await step('Search everything finds words in the kept chat, and opens it', async () => {
  await max.goto(`${B}/drive`);
  await max.getByLabel('Search everything').fill('budget approved');
  const hit = max.getByRole('option', { name: /Budget is approved/ });
  await hit.waitFor();
  if (!/Max Meet · Planning/.test(await hit.innerText())) throw new Error(await hit.innerText());
  await max.getByText('Meeting chats').first().waitFor();
  await hit.click();
  await max.waitForURL(`**/meet`);
  await max.getByRole('dialog', { name: 'Chat from Planning' }).getByText('Great, next item').waitFor();
  await max.getByLabel('Search everything').fill('not kept this one');
  await max.waitForTimeout(1200);
  if (await max.getByRole('option', { name: /Not kept, this one/ }).count()) throw new Error('found what was not kept');
}, max);
await step('Olivia, who started it, deletes it: gone for everyone, the Chat button goes', async () => {
  await page.goto(`${B}/meet`);
  await page.getByRole('button', { name: 'Chat from Planning' }).click();
  const d = page.getByRole('dialog', { name: 'Chat from Planning' });
  await d.getByRole('button', { name: 'Delete chat' }).click();
  await page.getByRole('dialog', { name: 'Delete the meeting chat?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Meeting chat deleted').waitFor();
  await d.waitFor({ state: 'detached' });
  if (await page.getByRole('button', { name: 'Chat from Planning' }).count()) throw new Error('still offered');
  await max.goto(`${B}/meet`);
  await max.getByRole('button', { name: 'Who joined Planning' }).waitFor();
  if (await max.getByRole('button', { name: 'Chat from Planning' }).count()) throw new Error('still offered to Max');
});
await step('a meeting with nothing kept has no Chat button', async () => {
  await page.goto(`${B}/meet`);
  await page.getByLabel('Meeting name (optional)').fill('Quiet one');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await page.getByRole('button', { name: 'Leave the meeting' }).click();
  await page.goto(`${B}/meet`);
  await page.getByRole('button', { name: 'Who joined Quiet one' }).waitFor();
  if (await page.getByRole('button', { name: 'Chat from Quiet one' }).count()) throw new Error('shown');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
