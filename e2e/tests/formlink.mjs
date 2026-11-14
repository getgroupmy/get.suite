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

const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let general, f, kim;
await step('a form link in Chat: a card with Fill in, and the team sees how many answered', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const made = (await api(page, 'POST', '/forms', { title: 'Offsite dates' })).body;
  f = (await api(page, 'PUT', `/forms/${made.id}`, { description: 'Pick the week that suits you', one_per_person: true, questions: [{ id: 'd', type: 'choice', title: 'Which week?', options: ['First', 'Second'] }, { id: 'n', type: 'short', title: 'Anything else?' }] })).body;
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  await page.getByLabel('Message', { exact: true }).fill(`Please answer by Friday: ${B}/f/${f.token}`);
  await page.getByLabel('Message', { exact: true }).press('Enter');
  const card = page.getByRole('link', { name: 'Form: Offsite dates' });
  await card.waitFor();
  const txt = await card.textContent();
  if (!/Pick the week/.test(txt) || !/2 questions/.test(txt) || !/0 responses/.test(txt) || !/Fill in/.test(txt)) throw new Error(txt);
});
await step('Kim fills it in from the card; afterwards it says so', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${general}`);
  const card = kim.getByRole('link', { name: 'Form: Offsite dates' });
  await card.waitFor();
  if (/responses/.test(await card.textContent())) throw new Error('only the team sees how many');
  const [tab] = await Promise.all([kim.context().waitForEvent('page'), card.click()]);
  await tab.getByRole('radio', { name: 'Second' }).check();
  await tab.getByRole('button', { name: 'Submit' }).click();
  await tab.getByText(/recorded|Thanks/i).first().waitFor();
  await tab.close();
  await kim.reload();
  const again = kim.getByRole('link', { name: 'Form: Offsite dates' });
  await again.waitFor();
  const txt = await again.textContent();
  if (!/You’ve responded/.test(txt) || /Fill in|Respond again/.test(txt)) throw new Error(txt);
  await kim.screenshot({ path: `${SP}/shots/formlink-kim.png` });
  await page.reload();
  try { await until(async () => /1 response(?!s)/.test(await page.getByRole('link', { name: 'Form: Offsite dates' }).textContent())); } catch (e) { console.log('DBG', await page.getByRole('link', { name: 'Form: Offsite dates' }).textContent(), JSON.stringify((await api(page, 'GET', `/public/forms/${f.token}`)).body).slice(0, 300)); throw e; }
});
await step('the form card keeps up: a new response shows on Olivia’s open card', async () => {
  await page.goto(`${B}/chat/${general}`);
  const card = page.getByRole('link', { name: 'Form: Offsite dates' });
  await until(async () => /1 response(?!s)/.test(await card.textContent()));
  await api(page, 'POST', '/users', { local: 'pat', domain: 'acme.com', name: 'Pat Lim', password: 'password123' });
  const pat = await mk('pat'); await signIn(pat, 'pat@acme.com');
  await pat.goto(`${B}/f/${f.token}`);
  await pat.getByRole('radio', { name: 'First' }).check();
  await pat.getByRole('button', { name: 'Submit' }).click();
  await pat.getByText(/recorded|Thanks/i).first().waitFor();
  await until(async () => /2 responses/.test(await card.textContent()), 10000);
});
await step('closed, and a form that does not exist', async () => {
  await api(page, 'PUT', `/forms/${f.id}`, { accepting: false });
  await api(page, 'POST', `/chat/channels/${general}/messages`, { body: `${B}/f/doesnotexist123` });
  await kim.reload();
  const card = kim.getByRole('link', { name: 'Form: Offsite dates' });
  await card.waitFor();
  if (/Fill in/.test(await card.textContent())) throw new Error('closed');
  await kim.getByText('A form you can’t open').waitFor();
});
await step('Send in Chat… from the form’s Send window: a form card', async () => {
  await page.goto(`${B}/forms/${f.id}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const d = page.getByRole('dialog').first();
  await d.getByRole('tab', { name: 'Link and QR code' }).click();
  await d.getByRole('button', { name: 'Send in Chat…' }).click();
  const s = page.getByRole('dialog', { name: 'Send the form in Chat' });
  await s.waitFor();
  await s.getByLabel('Conversation').selectOption({ label: '# general' });
  await s.getByRole('button', { name: 'Open in Chat' }).click();
  await page.waitForURL(`**/chat/${general}`);
  const box = page.getByLabel('Message', { exact: true });
  await until(async () => (await box.inputValue()).includes(`/f/${f.token}`));
  if (!(await box.inputValue()).startsWith('Offsite dates: ')) throw new Error(await box.inputValue());
  const before = await page.getByRole('link', { name: 'Form: Offsite dates' }).count();
  await box.press('Enter');
  await until(async () => (await page.getByRole('link', { name: 'Form: Offsite dates' }).count()) === before + 1);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
