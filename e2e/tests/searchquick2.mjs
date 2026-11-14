import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const search = () => page.getByLabel('Search everything');
const actions = () => page.getByRole('group', { name: 'Actions' });
const first = () => actions().getByRole('option').first();
await step('a colleague', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
});
await step('"email @kim Budget figures": a new message to Kim with that subject', async () => {
  await page.goto(`${B}/home`);
  await search().fill('email @kim Budget figures');
  await until(async () => (await first().textContent().catch(() => '')).startsWith('Email Kim Park'));
  if (!(await first().textContent()).includes('“Budget figures”')) throw new Error(await first().textContent());
  await search().press('ArrowDown');
  await search().press('Enter');
  await page.waitForURL(/\/mail/);
  await until(async () => (await page.getByLabel('Subject').inputValue().catch(() => '')) === 'Budget figures');
  const to = await page.getByLabel('To', { exact: true }).inputValue();
  if (!to.includes('kim@acme.com')) throw new Error(to);
  if (/subject=|compose=/.test(page.url())) throw new Error(`left in the address: ${page.url()}`);
  await page.screenshot({ path: `${SP}/shots/search-email.png` });
});
await step('"email" with nobody named: just the plain "Write an email"', async () => {
  await page.goto(`${B}/home`);
  await search().fill('email the team');
  await page.waitForTimeout(400);
  if (await actions().count() && /^Email /.test(await first().textContent())) throw new Error('a detailed one for nobody');
});
await step('"list milk, eggs #shopping" adds that checklist; "note …" a note; Open shows it', async () => {
  await search().fill('list milk, eggs, bread #shopping');
  await until(async () => (await first().textContent().catch(() => '')).startsWith('Add checklist: milk, eggs, bread'));
  await first().click();
  await page.getByText('Checklist added to Notes').waitFor();
  await search().fill('note Call the bank about the card');
  await until(async () => (await first().textContent().catch(() => '')).startsWith('Add note: Call the bank'));
  await search().press('ArrowDown');
  await search().press('Enter');
  await page.getByText('Note added').waitFor();
  const notes = (await api(page, 'GET', '/notes')).body;
  const all = notes.notes || notes;
  const l = all.find((n) => n.items?.length === 3);
  const n = all.find((x) => x.body === 'Call the bank about the card');
  if (!l || JSON.stringify(l.labels) !== '["shopping"]' || l.items.map((i) => i.text).join() !== 'milk,eggs,bread' || !n) throw new Error(JSON.stringify(all));
  await page.getByRole('button', { name: 'Open' }).last().click();
  await page.waitForURL(/\/notes/);
  await page.getByRole('dialog').getByText('Call the bank about the card').waitFor();
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
