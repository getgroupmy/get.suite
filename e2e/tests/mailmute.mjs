import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
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
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
let kim, mid;
const send = async (p, body) => { for (let k = 0; k < 15; k++) { const r = await api(p, 'POST', '/mail/send', body); if (r.status === 200) return r; await p.waitForTimeout(1500); } throw new Error('could not send'); };
await step('a colleague starts a conversation; Mute archives it', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const ctx = await browser.newContext(); kim = await ctx.newPage();
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await send(kim, { to: 'olivia@acme.com', subject: 'Lunch plans for everyone', text: 'Where shall we go?' });
  const row = page.locator('.mail-list').getByText('Lunch plans for everyone', { exact: true });
  await refreshUntil(page, row);
  await row.click();
  const reader = page.locator('.mail-reader');
  await reader.getByRole('button', { name: 'Mute' }).click();
  await page.getByText('Muted: this conversation is archived, and replies go straight to Archive').waitFor();
  await until(async () => !(await row.count()));
  const muted = (await api(page, 'GET', '/mail/muted')).body;
  if (muted.length !== 1 || muted[0].subject !== 'Lunch plans for everyone') throw new Error(JSON.stringify(muted));
  mid = muted[0].message_ids[0];
});
await step('a reply skips the Inbox, arrives read in Archive, and shows as muted there', async () => {
  await page.waitForTimeout(2500); // the server writes the rule for the mail server
  await send(kim, { to: 'olivia@acme.com', subject: 'Re: Lunch plans for everyone', text: 'Pizza!', inReplyTo: mid, references: [mid] });
  await send(kim, { to: 'olivia@acme.com', subject: 'Unrelated news', text: 'Hello' });
  await refreshUntil(page, page.locator('.mail-list').getByText('Unrelated news', { exact: true }));
  const archive = (await api(page, 'GET', '/mail/folders')).body.find((f) => f.specialUse === '\\Archive');
  await until(async () => (await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(archive.path)}`)).body.messages.some((m) => m.subject === 'Re: Lunch plans for everyone' && m.seen), 30000);
  if (await page.locator('.mail-list').getByText('Re: Lunch plans for everyone', { exact: true }).count()) throw new Error('in the inbox');
  await page.getByRole('button', { name: /^Archive/ }).first().click();
  await page.locator('.mail-list').getByText('Re: Lunch plans for everyone', { exact: true }).click();
  await page.getByText('This conversation is muted: replies go straight to Archive.').waitFor();
});
await step('Filters lists muted conversations; Unmute there', async () => {
  await page.getByRole('button', { name: 'Filters' }).click();
  const list = page.getByRole('region', { name: 'Muted conversations' });
  await list.getByText('Lunch plans for everyone').waitFor();
  await list.getByRole('button', { name: 'Unmute' }).click();
  await until(async () => !(await list.count()));
  if ((await api(page, 'GET', '/mail/muted')).body.length) throw new Error('still muted');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
