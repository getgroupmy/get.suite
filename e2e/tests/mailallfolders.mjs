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
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await page.waitForTimeout(400); } };
const inboxNow = async (q) => (await api(page, 'GET', `/mail/messages?folder=INBOX&q=${encodeURIComponent(q)}`)).body?.messages || [];
await step('a message filed away in a folder of its own', async () => {
  for (let k = 0; k < 10; k++) { if ((await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Walrus plan', text: 'For the zoo' })).status === 200) break; await page.waitForTimeout(1500); }
  await until(async () => (await inboxNow('walrus')).length === 1);
  const m = (await inboxNow('walrus'))[0];
  if ((await api(page, 'POST', '/mail/folders', { name: 'Projects/Zoo' })).status !== 201) throw new Error('folder');
  if ((await api(page, 'POST', '/mail/messages/move', { folder: 'INBOX', uids: [m.uid], to: 'Projects/Zoo' })).status !== 200) throw new Error('move');
});
await step('searching the Inbox finds nothing; “Search all folders” finds it, saying where; a click opens it there', async () => {
  await page.goto(`${B}/mail?q=walrus`);
  await page.getByText('Results for “walrus” in Inbox').waitFor();
  await page.getByRole('button', { name: 'Search all folders' }).click();
  const found = page.getByRole('region', { name: 'Found in all folders' });
  await found.getByText(/In all folders: [12]/).waitFor({ timeout: 20000 });
  const row = found.getByRole('button').filter({ hasText: 'Walrus plan' }).filter({ hasText: 'Projects / Zoo' });
  await row.waitFor();
  await page.screenshot({ path: `${SP}/shots/mail-all-folders.png` });
  const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.evaluate(AXE);
    const bad = await page.evaluate(async () => (await window.axe.run(document.querySelector('.all-folders'), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`));
    if (bad.length) throw new Error(`${scheme}: ${bad.join(' | ')}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await row.click();
  await page.waitForURL(/\/mail\/Projects%2FZoo\/\d+/);
  await page.getByText('For the zoo').first().waitFor({ timeout: 20000 });
});
await step('Search everything at the top finds it in its folder too', async () => {
  await page.goto(`${B}/drive`);
  const box = page.getByRole('combobox', { name: 'Search everything' });
  await box.fill('walrus');
  const mail = page.getByRole('listbox').getByRole('group', { name: 'Mail' });
  await mail.getByText('Walrus plan').first().waitFor({ timeout: 20000 });
  await mail.getByText(/Projects \/ Zoo/).waitFor();
  await mail.getByRole('option').filter({ hasText: 'Projects / Zoo' }).click();
  await page.waitForURL(/\/mail\/Projects%2FZoo\/\d+/);
});
await step('nothing anywhere says so', async () => {
  await page.goto(`${B}/mail?q=${encodeURIComponent('narwhal')}`);
  await page.getByRole('button', { name: 'Search all folders' }).click();
  await page.getByRole('region', { name: 'Found in all folders' }).getByText('Nothing in the other folders either').waitFor({ timeout: 20000 });
  await page.getByRole('region', { name: 'Found in all folders' }).getByRole('button', { name: 'Hide' }).click();
  await page.getByRole('region', { name: 'Found in all folders' }).waitFor({ state: 'detached' });
});

if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
