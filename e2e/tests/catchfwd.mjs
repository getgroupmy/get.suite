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
const api = (p, method, url, body, raw) => p.evaluate(async ([m, u, b, r]) => {
  const res = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', ...(r ? {} : { 'content-type': 'application/json' }) }, body: r ? b : b ? JSON.stringify(b) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, url, body, raw]);
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
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  const u = await api(page, 'POST', '/users', { local: 'frontdesk', domain: 'acme.com', name: 'Front Desk', password: 'password123' });
  if (u.status !== 201) throw new Error(JSON.stringify(u));
});

await step('set-catch-all', async () => {
  await page.goto(B + '/admin');
  await page.getByRole('tab', { name: 'Email' }).click();
  await page.getByLabel('Catch-all for acme.com').selectOption('frontdesk@acme.com');
  await page.locator('.toast', { hasText: 'now goes to frontdesk@acme.com' }).waitFor();
  await page.locator('.card', { hasText: 'Catch-all' }).first().screenshot({ path: `${SP}/shots/catchall.png` });
  await page.reload();
  await page.getByRole('tab', { name: 'Email' }).click();
  if ((await page.getByLabel('Catch-all for acme.com').inputValue()) !== 'frontdesk@acme.com') throw new Error('not saved');
});

const gina = await mk('gina');
const desk = await mk('frontdesk');
await step('mail-to-unknown-address-arrives', async () => {
  await signIn(gina, 'gina@globex.com');
  await gina.getByText('Inbox is empty').waitFor({ timeout: 30000 });
  await gina.waitForTimeout(2500);
  const r = await api(gina, 'POST', '/mail/send', { to: 'bookings@acme.com', subject: 'Booking for a container', text: 'Do you have space?' });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  await signIn(desk, 'frontdesk@acme.com');
  const row = desk.locator('.msg-list li', { hasText: 'Booking for a container' });
  await refreshUntil(desk, row);
}, desk);

await step('forward-keeps-chosen-attachments', async () => {
  const up = async (name, body) => (await page.evaluate(async ([n, b]) => {
    const res = await fetch(`/api/files/upload?name=${n}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: b });
    return res.json();
  }, [name, body]));
  const a = await up('contract.txt', 'CONTRACT');
  const b = await up('prices.csv', 'a,b\n1,2\n');
  const r = await api(page, 'POST', '/mail/send', { to: 'gina@globex.com', subject: 'Contract and prices', text: 'Both attached.', attachments: [a.id, b.id] });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  await gina.getByRole('button', { name: /^Inbox/ }).click();
  const row = gina.locator('.msg-list li', { hasText: 'Contract and prices' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  await gina.locator('a.att', { hasText: 'prices.csv' }).waitFor();
  await gina.getByRole('button', { name: 'Forward', exact: true }).click();
  const chips = gina.getByRole('list', { name: 'Forwarded attachments' });
  await chips.getByText('contract.txt').waitFor();
  await chips.getByText('prices.csv').waitFor();
  await gina.getByRole('button', { name: 'Remove prices.csv' }).click();
  if (await chips.getByText('prices.csv').count()) throw new Error('not removed');
  await gina.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await gina.screenshot({ path: `${SP}/shots/forward-attachments.png` });
  await gina.getByRole('button', { name: 'Send', exact: true }).click();
  await gina.getByText('Sent to 1 recipient').waitFor();
}, gina);

await step('forward-arrives-with-one-attachment', async () => {
  await page.goto(B + '/mail');
  const row = page.locator('.msg-list li', { hasText: 'Fwd: Contract and prices' });
  await refreshUntil(page, row);
  await row.locator('.msg-row').click();
  await page.locator('a.att', { hasText: 'contract.txt' }).waitFor();
  if (await page.locator('a.att', { hasText: 'prices.csv' }).count()) throw new Error('removed attachment was sent');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
