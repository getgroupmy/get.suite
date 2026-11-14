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
const list = () => page.locator('.mail-list');
const reader = () => page.locator('.reader-actions');
const inFolder = async (f) => ((await api(page, 'GET', `/mail/messages?folder=${f}`)).body.messages || []).map((m) => m.subject);
const undoIn = (text) => page.locator('.toast', { hasText: text }).getByRole('button', { name: 'Undo' });
await step('archive a message, then Undo: back in the Inbox', async () => {
  for (const s of ['Quarterly numbers', 'Lunch on Friday', 'Parking notice']) if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: s, text: 'x' })).status !== 200) throw new Error('send');
  await until(async () => (await inFolder('INBOX')).length >= 3, 40000);
  await page.reload();
  await list().getByText('Quarterly numbers', { exact: true }).click({ timeout: 30000 });
  await reader().getByRole('button', { name: 'Archive', exact: true }).click();
  await undoIn('Archived').waitFor();
  await until(async () => (await inFolder('Archive')).includes('Quarterly numbers'));
  await page.screenshot({ path: `${SP}/shots/mailundo.png` });
  await undoIn('Archived').click();
  await page.getByText('Put back', { exact: true }).waitFor();
  await until(async () => (await inFolder('INBOX')).includes('Quarterly numbers') && !(await inFolder('Archive')).includes('Quarterly numbers'));
  await list().getByText('Quarterly numbers', { exact: true }).waitFor();
});
await step('delete two at once, then Undo puts both back', async () => {
  await page.getByRole('checkbox', { name: 'Select Lunch on Friday' }).check();
  await page.getByRole('checkbox', { name: 'Select Parking notice' }).check();
  await page.locator('.mail-bulk').getByRole('button', { name: 'Delete', exact: true }).click();
  await undoIn('Moved to Trash').waitFor();
  await until(async () => (await inFolder('Trash')).length === 2);
  await undoIn('Moved to Trash').click();
  await page.getByText('Put back 2 messages').waitFor();
  await until(async () => { const i = await inFolder('INBOX'); return i.includes('Lunch on Friday') && i.includes('Parking notice'); });
  if ((await inFolder('Trash')).length) throw new Error('still in Trash');
});
await step('report spam and Undo; deleting for good offers no Undo', async () => {
  await list().getByText('Parking notice', { exact: true }).click();
  await reader().getByRole('button', { name: 'Report spam' }).click();
  await undoIn('Moved to Junk').click();
  await until(async () => (await inFolder('INBOX')).includes('Parking notice'));
  await list().getByText('Lunch on Friday', { exact: true }).click();
  await reader().getByRole('button', { name: 'Delete', exact: true }).click();
  await until(async () => (await inFolder('Trash')).includes('Lunch on Friday'));
  await page.goto(`${B}/mail/Trash`);
  await list().getByText('Lunch on Friday', { exact: true }).click({ timeout: 20000 });
  await reader().getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('Deleted forever').waitFor();
  if (await page.locator('.toast', { hasText: 'Deleted forever' }).getByRole('button', { name: 'Undo' }).count()) throw new Error('undo offered');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
