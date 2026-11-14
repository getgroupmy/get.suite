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
const editor = (p) => p.getByRole('textbox', { name: 'Message' });

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let kim;
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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const id = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PATCH', `/users/${id}`, { job_title: 'Designer', department: 'Product', work_phone: '+60 3-555 0101' });
});
await step('give a group an email address in Admin → Groups', async () => {
  const id = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  const g = (await api(page, 'POST', '/groups', { name: 'Help Desk' })).body;
  await api(page, 'PUT', `/groups/${g.id}/members`, { user_ids: [id] });
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Groups' }).or(page.getByRole('button', { name: 'Groups', exact: true })).first().click();
  const card = page.getByRole('listitem', { name: 'Group Help Desk' });
  await card.getByLabel('Address for Help Desk').fill('helpdesk');
  await card.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Mail to helpdesk@acme.com now reaches everyone in Help Desk').waitFor();
  await card.getByText('Members get mail sent to helpdesk@acme.com and can send from it.').waitFor();
});
await step('mail to it reaches Kim', async () => {
  await page.waitForTimeout(6500);
  const r = await api(page, 'POST', '/mail/send', { to: 'helpdesk@acme.com', subject: 'Printer jam', text: 'Third floor' });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  const kim = await mk('kim');
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await kim.goto(`${B}/mail`);
  for (let i = 0; i < 30 && !(await kim.getByText('Printer jam').count()); i++) { await kim.getByRole('button', { name: 'Refresh' }).click().catch(() => {}); await kim.waitForTimeout(700); }
  await kim.getByText('Printer jam').first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
