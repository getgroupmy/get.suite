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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const send = async (subject) => { for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject, text: `About ${subject}` })).status === 200) break; await page.waitForTimeout(1500); } };
const reader = () => page.locator('.mail-reader');
const row = (s) => page.locator('.mail-list').getByText(s, { exact: true });
await step('chat: a direct message with a colleague whose vacation reply is on says they are away, until when', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(`user ${r.status}`);
  const kim = await browser.newPage();
  await kim.goto(B);
  await kim.getByLabel('Email address').fill('kim@acme.com');
  await kim.getByLabel('Password').fill('password123');
  await kim.getByRole('button', { name: 'Sign in' }).click();
  await kim.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const end = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
  let v;
  for (let k = 0; k < 10; k++) { v = await api(kim, 'PUT', '/mail/vacation', { enabled: true, subject: 'Hiking in the Alps', body: 'Back soon.', end_date: end }); if (v.status === 200) break; await kim.waitForTimeout(1500); }
  if (v.status !== 200) throw new Error(`vacation ${v.status}`);
  const dm = (await api(page, 'POST', '/chat/dm', { user_id: r.body.id })).body.id;
  await page.goto(`${B}/chat/${dm}`);
  const note = page.locator('.chat-late').filter({ hasText: 'is away' });
  await note.getByText('Kim Park').waitFor({ timeout: 10000 });
  await note.getByText(/is away until/).waitFor();
  await note.getByText('“Hiking in the Alps”').waitFor();
  await page.screenshot({ path: `${SP}/shots/chat-away.png` });
  // The Calendar's event window says so too, for an event while they're away.
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Review');
  const day = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  await dlg.getByLabel('Starts').fill(day);
  await dlg.getByLabel('Ends').fill(day);
  await dlg.getByRole('combobox', { name: 'Guests' }).fill('kim@acme.com');
  await dlg.getByRole('combobox', { name: 'Guests' }).press('Enter');
  await dlg.getByRole('list', { name: 'Guests at this time' }).getByText(/away until .* \(vacation reply on\)/).waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  // Home's Who's out lists them, back the next working day after their reply ends.
  await page.goto(`${B}/home`);
  const out = page.getByRole('region', { name: "Who's out" });
  await out.getByText('Kim Park').waitFor({ timeout: 10000 });
  await out.getByText(/back /).waitFor();
  // Their status in the Directory says so too.
  await page.goto(`${B}/contacts?tab=dir`);
  await page.getByText(/Away until/).first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SP}/shots/dir-away.png` });
  await page.goto(`${B}/chat/${dm}`);
  await api(kim, 'PUT', '/mail/vacation', { enabled: false, body: 'x' });
  await page.reload();
  await page.getByRole('textbox', { name: 'Message' }).waitFor();
  await page.waitForTimeout(800);
  if (await note.count()) throw new Error('still shown after the reply was turned off');
  await kim.close();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
