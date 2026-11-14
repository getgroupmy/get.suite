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
await step('the admin writes a company signature for people without their own', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: /Company settings/ }).or(page.getByRole('button', { name: /Company settings/ })).first().click();
  const card = page.locator('form[aria-labelledby="csig-h"]');
  await card.getByLabel('Signature').fill('{name}\n{job_title} · {department}\nAcme Trading · {work_phone}');
  await card.getByRole('button', { name: 'Save signature' }).click();
  await page.getByText('Company signature saved').waitFor();
  await until(async () => await card.getByLabel('People who haven’t written their own').isChecked());
});
await step('Kim gets it, filled in, in new messages', async () => {
  kim = await mk('kim');
  await kim.goto(B);
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await kim.goto(`${B}/mail`);
  await kim.getByRole('button', { name: 'Compose' }).waitFor({ timeout: 30000 });
  await kim.getByRole('button', { name: 'Compose' }).click();
  await kim.locator('.compose-editor').getByText('Designer · Product').waitFor();
  await kim.locator('.compose-editor').getByText('Acme Trading · +60 3-555 0101').waitFor();
  await kim.keyboard.press('Escape');
});
await step('Everyone: Kim sees it in Signature, and can’t change it', async () => {
  await page.locator('form[aria-labelledby="csig-h"]').getByLabel('Everyone (people can’t change theirs)').check();
  await page.getByText('Everyone now uses the company signature').waitFor();
  await kim.goto(`${B}/mail`);
  await kim.getByRole('button', { name: 'Signature' }).click();
  const d = kim.getByRole('dialog', { name: 'Signatures' });
  await d.getByText(/Your company uses one signature for everyone/).waitFor();
  await d.getByLabel('Company signature').getByText('Kim Park').waitFor();
  if (await d.getByRole('button', { name: 'Save' }).count()) throw new Error('no save when it is for everyone');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
