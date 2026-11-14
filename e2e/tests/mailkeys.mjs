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
const reader = () => page.locator('.mail-reader');
const subjectShown = () => reader().locator('h1, h2').first().innerText();
await step('three messages arrive; j opens the newest, j/k move, u goes back', async () => {
  for (const s of ['First note', 'Second note', 'Third note']) {
    for (let k = 0; k < 5; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: s, text: `Body of ${s}` })).status === 200) break; await page.waitForTimeout(1000); }
    await page.waitForTimeout(400);
  }
  await page.locator('.mail-list').getByText('First note', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('.mail-list').getByText('Third note', { exact: true }).waitFor({ timeout: 30000 });
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('j');
  await reader().getByText('Body of Third note').waitFor();
  await page.keyboard.press('j');
  await reader().getByText('Body of Second note').waitFor();
  await page.keyboard.press('k');
  await reader().getByText('Body of Third note').waitFor();
  await page.keyboard.press('u');
  await page.waitForURL((u) => !/\/\d+(\?|$)/.test(u.pathname));
  await reader().getByText('No message selected').waitFor();
});
await step('s stars, e archives, # deletes the open message', async () => {
  await page.keyboard.press('j');
  await reader().getByText('Body of Third note').waitFor();
  await page.keyboard.press('s');
  await reader().getByRole('button', { name: 'Unstar' }).waitFor();
  await page.keyboard.press('e');
  await page.getByText('Archived').waitFor();
  await until(async () => (await page.locator('.mail-list').getByText('Third note', { exact: true }).count()) === 0);
  await page.keyboard.press('j');
  await reader().getByText('Body of Second note').waitFor();
  await page.keyboard.press('#');
  await page.getByText('Moved to Trash').waitFor();
  await until(async () => (await page.locator('.mail-list').getByText('Second note', { exact: true }).count()) === 0);
});
await step('r replies; c writes a new message; typing in a box is not a shortcut', async () => {
  await page.keyboard.press('j');
  await reader().getByText('Body of First note').waitFor();
  await page.keyboard.press('r');
  const subject = page.getByLabel('Subject');
  await subject.waitFor();
  if ((await subject.inputValue()) !== 'Re: First note') throw new Error(await subject.inputValue());
  await page.keyboard.type('jjj');
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByLabel('Subject').waitFor({ state: 'detached' }).catch(() => {});
  await page.keyboard.press('c');
  await page.getByLabel('Subject').waitFor();
  if ((await page.getByLabel('Subject').inputValue()) !== '') throw new Error('new message has a subject');
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.keyboard.press('/');
  if (!(await page.getByLabel('Search mail').evaluate((el) => el === document.activeElement))) throw new Error('search not focused');
  await page.keyboard.type('j');
  if ((await page.getByLabel('Search mail').inputValue()) !== 'j') throw new Error('j was typed into search');
});
await step('the shortcuts list has the Mail keys', async () => {
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('?');
  await page.getByText('Older or newer message').waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
