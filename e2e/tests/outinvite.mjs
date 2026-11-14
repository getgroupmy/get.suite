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

const { DatabaseSync } = await import('node:sqlite');
const tokenFor = (email) => new DatabaseSync(`${SP}/data/workspace.db`, { readOnly: true }).prepare('SELECT token FROM event_outside_guests WHERE email = ?').get(email)?.token;
const outsider = 'dana@clients-test.example';
let token;
await step('invite someone outside: marked "by email", with a note', async () => {
  await page.goto(B + '/calendar');
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Site visit');
  await dlg.getByLabel('Location').fill('12 Harbour Road');
  await page.locator('#guest-input').fill(outsider);
  await page.locator('#guest-input').press('Enter');
  const chip = page.getByRole('list', { name: 'Invited guests' }).getByRole('listitem').filter({ hasText: outsider });
  await chip.getByText('· by email').waitFor();
  await dlg.getByText(/People outside Workspace get an email invitation/).waitFor();
  await page.screenshot({ path: `${SP}/shots/outinvite-dialog.png` });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  token = tokenFor(outsider);
  if (!token) throw new Error('no outside guest stored');
});

const guestCtx = await browser.newContext({ viewport: { width: 390, height: 800 }, timezoneId: 'America/New_York' });
const dana = await guestCtx.newPage();
dana.on('pageerror', (e) => errors.push(`dana: ${e.message}`));
await step('the guest answers on the page, in their own time zone', async () => {
  await dana.goto(`${B}/i/${token}`);
  await dana.getByRole('heading', { name: 'Site visit' }).waitFor();
  await dana.getByText('Olivia Owner (olivia@acme.com) invited you').waitFor();
  await dana.getByText('your time (America/New_York)').waitFor();
  await dana.getByText('12 Harbour Road').waitFor();
  await dana.getByRole('button', { name: 'Maybe' }).click();
  await dana.getByText(/You might go\./).waitFor();
  if ((await dana.getByRole('button', { name: 'Maybe' }).getAttribute('aria-pressed')) !== 'true') throw new Error('not pressed');
  const over = await dana.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (over) throw new Error('horizontal scroll on a phone');
  await dana.screenshot({ path: `${SP}/shots/outinvite-answer.png` });
  const [dl] = await Promise.all([dana.waitForEvent('download'), dana.getByRole('link', { name: /Add to my calendar/ }).click()]);
  if (!/\.ics$/.test(dl.suggestedFilename())) throw new Error(dl.suggestedFilename());
}, dana);

await step('the organizer sees the answer live', async () => {
  await page.locator('.month .chip', { hasText: 'Site visit' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  await dlg.getByText('1 guest: 1 maybe').waitFor();
  await dlg.getByRole('list', { name: 'Invited guests' }).getByText('· Maybe').waitFor();
  await page.keyboard.press('Escape');
  await dana.getByRole('button', { name: 'Yes' }).click();
  await page.locator('.month .chip', { hasText: 'Site visit' }).click();
  await dlg.getByText('1 guest: 1 yes').waitFor();
  await page.keyboard.press('Escape');
});

await step('deleting the event ends the link', async () => {
  await page.locator('.month .chip', { hasText: 'Site visit' }).click();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Delete' }).click();
  await page.locator('.month .chip', { hasText: 'Site visit' }).waitFor({ state: 'detached' });
  await dana.reload();
  await dana.getByRole('heading', { name: 'Invitation not available' }).waitFor();
}, dana);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
