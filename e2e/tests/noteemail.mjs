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
let kim, note;
await step('a checklist note', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  note = (await api(page, 'POST', '/notes', { title: 'Trip packing', items: [{ text: 'Passport', done: true }, { text: 'Charger' }, { text: 'Adapter', indent: 1 }] })).body;
  if (!note?.id) throw new Error(JSON.stringify(note));
  await page.waitForTimeout(5000); // the mail server picks up the new mailbox
});
await step('⋮ → Send by email opens a new message with the note in it; it arrives', async () => {
  await page.goto(`${B}/notes`);
  const card = page.getByRole('article', { name: 'Trip packing' });
  await card.hover();
  await card.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send by email' }).click();
  const d = page.getByRole('dialog', { name: 'Trip packing' });
  await d.waitFor({ timeout: 30000 });
  if (await d.getByLabel('Subject').inputValue() !== 'Trip packing') throw new Error('subject');
  const msg = d.getByRole('textbox', { name: 'Message' });
  await msg.getByText('☑ Passport').waitFor();
  await msg.getByText('☐ Charger').waitFor();
  await msg.getByText(/From my notes:/).waitFor();
  const href = await msg.getByRole('link').first().getAttribute('href');
  if (href !== `${B}/notes?note=${note.id}`) throw new Error(`link ${href}`);
  await page.screenshot({ path: `${SP}/shots/note-email.png` });
  await d.getByLabel('To', { exact: true }).fill('kim@acme.com');
  await d.getByRole('button', { name: 'Send', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 30000 });
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.locator('.mail-list').getByText('Trip packing', { exact: true }).waitFor({ timeout: 40000 });
  await kim.locator('.mail-list').getByText('Trip packing', { exact: true }).click();
  await kim.frameLocator('iframe.mail-html').getByText('☐ Adapter').waitFor(); // HTML mail shows in a locked-down frame
});
await step('the note itself is unchanged', async () => {
  const n = (await api(page, 'GET', '/notes')).body;
  const list = Array.isArray(n) ? n : n.notes;
  if (list.find((x) => x.id === note.id).items.length !== 3) throw new Error('note changed');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
