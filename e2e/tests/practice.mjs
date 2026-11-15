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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const SUBJECT = 'A document has been shared with you: Q4 salary review.xlsx';
let kim, lee;
await step('Admin → Phishing → Practice emails: choose the email and who gets it, send', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['lee', 'Lee Chen']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  await page.goto(`${B}/admin?tab=phishing`);
  const card = page.getByRole('region', { name: 'Practice emails' });
  await card.getByLabel('Practice email').selectOption({ label: 'Shared document' });
  await card.getByText(`From Document Share: “${SUBJECT}”`).waitFor();
  await card.getByRole('checkbox', { name: /Kim Park/ }).check();
  await card.getByRole('checkbox', { name: /Lee Chen/ }).check();
  await axe(page, 'practice emails');
  await card.getByRole('button', { name: 'Send to 2 people' }).click();
  await page.getByText('Practice email sent to 2 people').waitFor();
  await card.getByRole('table', { name: 'Practice rounds' }).getByText('Shared document').waitFor();
});
await step('Kim reports it: “Well spotted!”', async () => {
  kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await refreshUntil(kim, kim.locator('.mail-list').getByText(SUBJECT));
  await kim.locator('.mail-list').getByText(SUBJECT).click();
  await kim.getByRole('button', { name: /Report phishing/ }).first().click();
  await kim.getByRole('dialog', { name: 'Report this email as phishing?' }).getByRole('button', { name: 'Report phishing' }).click();
  await kim.getByText('Well spotted! That was a practice phishing email from your admins. It’s in Junk').waitFor();
}, kim);
await step('Lee clicks its link: a page saying it was practice and what gave it away', async () => {
  lee = await mk('lee');
  await signIn(lee, 'lee@acme.com');
  await refreshUntil(lee, lee.locator('.mail-list').getByText(SUBJECT));
  await lee.locator('.mail-list').getByText(SUBJECT).click();
  const link = await lee.frameLocator('iframe[title="Message"]').getByRole('link', { name: /\/practice\// }).getAttribute('href')
    .catch(async () => (await lee.locator('.mail-reader').innerText()).match(/https?:\/\/\S+\/practice\/[\w-]+/)[0]);
  const p = await (await browser.newContext({ bypassCSP: true })).newPage(); // the page allows no scripts; axe needs one
  await p.goto(link);
  await p.getByRole('heading', { name: 'This was a practice phishing email' }).waitFor();
  await p.getByText(/Don’t worry, Lee Chen/).waitFor();
  await axe(p, 'practice page');
});
await step('the admin sees who reported it and who clicked', async () => {
  await page.goto(`${B}/admin?tab=phishing`);
  const card = page.getByRole('region', { name: 'Practice emails' });
  const row = card.getByRole('table', { name: 'Practice rounds' }).getByRole('row').nth(1);
  await row.getByText('1 (50%)').first().waitFor();
  await row.getByRole('button', { name: 'People' }).click();
  const list = card.getByRole('list', { name: 'People sent “Shared document”' });
  await list.locator('li', { hasText: 'Kim Park' }).getByText(/✓ reported it/).waitFor();
  await list.locator('li', { hasText: 'Lee Chen' }).getByText(/clicked the link/).waitFor();
  await page.screenshot({ path: `${SP}/shots/practice.png` });
});
await step('Security checkup names who clicked the latest practice email without reporting it', async () => {
  await page.goto(`${B}/admin?tab=checkup`);
  const item = page.getByRole('listitem').filter({ hasText: '1 person clicked the latest practice phishing email' });
  await item.getByText(/^Lee Chen\./).waitFor({ timeout: 20000 });
  await item.getByRole('button', { name: 'Go to Phishing' }).click();
  await page.getByRole('region', { name: 'Practice emails' }).waitFor();
});
await step('write your own practice email: Kim gets it as written, with the link where {link} was', async () => {
  await page.goto(`${B}/admin?tab=phishing`);
  const card = page.getByRole('region', { name: 'Practice emails' });
  await card.getByLabel('Practice email').selectOption('custom');
  await card.getByLabel('Pretends to be from').fill('DHL Express');
  await card.getByLabel('Subject').fill('Your parcel is held at customs');
  await card.getByLabel('Text').fill('A fee of RM 3.50 is due. Pay here: {link}\nDHL');
  await card.getByRole('checkbox', { name: /Kim Park/ }).check();
  await axe(page, 'custom practice email');
  await card.getByRole('button', { name: 'Send to 1 person' }).click();
  await page.getByText('Practice email sent to 1 person').waitFor();
  await card.getByRole('table', { name: 'Practice rounds' }).getByText('Custom: Your parcel is held at customs').waitFor();
  await kim.goto(`${B}/mail/INBOX`);
  await refreshUntil(kim, kim.locator('.mail-list').getByText('Your parcel is held at customs'));
  await kim.locator('.mail-list').getByText('Your parcel is held at customs').click();
  await kim.locator('.mail-reader').getByText('DHL Express', { exact: true }).waitFor();
  await kim.locator('.mail-reader').getByText(/A fee of RM 3\.50 is due\. Pay here: https?:\/\/\S+\/practice\//).waitFor();
});
await step('send automatically every 3 months: said what happens and when next, kept after a reload', async () => {
  await page.goto(`${B}/admin?tab=phishing`);
  const card = page.getByRole('region', { name: 'Practice emails' });
  await card.getByLabel('Send automatically').selectOption('3');
  await page.getByText('A practice round goes out every 3 months').waitFor();
  await card.getByRole('status').getByText(/A random third of the company gets one of the ready-made practice emails, sent as Olivia Owner; next on or after/).waitFor();
  await page.reload();
  if (await page.getByRole('region', { name: 'Practice emails' }).getByLabel('Send automatically').inputValue() !== '3') throw new Error('not kept');
  await axe(page, 'automatic practice');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
