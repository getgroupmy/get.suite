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
await step('To suggestions: the colleague you email most comes first; clicking picks them', async () => {
  for (const [local, name] of [['quinna', 'Quinn Adams'], ['quinnz', 'Quinn Zed']]) {
    const r = await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
    if (r.status !== 201) throw new Error(`user ${r.status}`);
  }
  const list = page.getByRole('listbox', { name: 'Suggestions for To' });
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).pressSequentially('quinn');
  await list.getByRole('option').first().getByText('Quinn Adams').waitFor({ timeout: 10000 }); // alphabetical to begin with
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close' }).last().click().catch(() => {});
  for (let i = 0; i < 2; i++) for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'quinnz@acme.com', subject: `Hi ${i}`, text: 'x' })).status === 200) break; await page.waitForTimeout(1500); }
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).pressSequentially('quinn');
  await list.getByRole('option').first().getByText('Quinn Zed').waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${SP}/shots/suggest-rank.png` });
  await list.getByRole('option').first().click();
  await until(async () => /quinnz@acme\.com/.test(await page.getByLabel('To', { exact: true }).inputValue()));
});
await step('To suggestions: a company finds the contacts there, and says the company', async () => {
  for (const [name, email] of [['Ada Stone', 'ada@initrode.example'], ['Ben Vale', 'ben.vale@post.example']]) await api(page, 'POST', '/contacts', { name, email, company: 'Initrode Works' });
  await api(page, 'POST', '/contacts', { name: 'Cy Marsh', email: 'cy@other.example', company: 'Elsewhere' });
  const to = page.getByLabel('To', { exact: true });
  const list = page.getByRole('listbox', { name: 'Suggestions for To' });
  await to.fill('');
  await to.pressSequentially('works');
  await list.getByRole('option').filter({ hasText: 'Ben Vale' }).getByText('· Initrode Works').waitFor({ timeout: 10000 });
  await list.getByRole('option').filter({ hasText: 'Ada Stone' }).waitFor();
  if (await list.getByRole('option').count() !== 2) throw new Error('only the two people at the company');
  await to.fill('');
  await to.pressSequentially('ben initrode');
  await until(async () => (await list.getByRole('option').count()) === 1 && /Ben Vale/.test(await list.innerText()), 10000);
  await page.screenshot({ path: `${SP}/shots/suggest-company.png` });
  await page.keyboard.press('Enter');
  await until(async () => /ben\.vale@post\.example/.test(await to.inputValue()));
});
await step('To suggestions: a company finds a contact’s other addresses too', async () => {
  const r = await api(page, 'POST', '/contacts', { name: 'Dee Holt', email: 'dee@quartz.example', company: 'Quartz Mill', more_emails: [{ label: 'Home', value: 'dee@home.example' }] });
  if (r.status !== 201) throw new Error(`contact ${r.status}`);
  const to = page.getByLabel('To', { exact: true });
  const list = page.getByRole('listbox', { name: 'Suggestions for To' });
  await to.fill('');
  await to.pressSequentially('mill');
  await list.getByRole('option').filter({ hasText: 'dee@home.example' }).getByText('· Quartz Mill').waitFor({ timeout: 10000 });
  await list.getByRole('option').filter({ hasText: 'dee@quartz.example' }).waitFor();
  await to.fill('');
  await to.pressSequentially('home quartz');
  await until(async () => (await list.getByRole('option').count()) === 1 && /dee@home\.example/.test(await list.innerText()), 10000);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
