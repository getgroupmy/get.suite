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
const inboxRow = (subject) => page.locator('.mail-list').getByText(subject, { exact: true });
const compose = async (subject, text) => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill(subject);
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type(text);
};
const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: 25, secure: false, ignoreTLS: true, name: "test.acme.com" });
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const results = {};
const audit = async (name) => {
  await page.addScriptTag({ content: AXE });
  results[name] = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations
    .map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, eg: v.nodes.slice(0, 2).map((x) => `${x.target.join(' ')} :: ${x.failureSummary?.slice(0, 160)}`) })));
};
await step('mail screens', async () => {
  await smtp.sendMail({ from: 'Pat Partner <pat@acme.com>', to: 'olivia@acme.com', subject: 'Quarterly numbers', text: 'Figures attached.', attachments: [{ filename: 'q3.csv', content: 'a,b\n1,2' }] });
  await refreshUntil(page, inboxRow('Quarterly numbers'));
  await audit('inbox');
  await inboxRow('Quarterly numbers').click();
  await page.getByRole('button', { name: 'Reply', exact: true }).waitFor();
  await audit('message');
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByRole('dialog').waitFor();
  await audit('compose');
  await page.keyboard.press('Escape');
  await page.goto(`${B}/settings`);
  await page.waitForTimeout(1500);
  await audit('settings-mail');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${B}/mail`);
  await refreshUntil(page, inboxRow('Quarterly numbers'));
  await audit('dark-inbox');
});
(await import('node:fs')).writeFileSync(`${SP}/a11ymail.json`, JSON.stringify(results, null, 1));
await step('no accessibility problems in Mail', async () => {
  const bad = Object.entries(results).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.map((x) => `${x.id} ×${x.n} (${x.eg[0]})`).join(', ')}`);
  if (bad.length) throw new Error(bad.join(' | ').slice(0, 1500));
});
await browser.close();
process.exit(failed ? 1 : 0);
