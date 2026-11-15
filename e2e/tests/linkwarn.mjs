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
const AXE = (await import('node:fs')).readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const putHtml = (subject, html, extra = '') => page.evaluate(async ([s, h, x]) => (await fetch('/api/mail/messages/upload?folder=INBOX', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'message/rfc822' },
  body: `From: "Bank" <alerts@mybank.example>\r\nTo: olivia@acme.com\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/\W/g, '')}${Date.now()}@x>\r\nDate: ${new Date().toUTCString()}\r\n${x}MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${h}\r\n` })).status, [subject, html, extra]);
const frame = () => page.frameLocator('iframe[title="Message"]');
const openMsg = async (subject, tab = 'Primary') => {
  await page.goto(`${B}/mail/INBOX`);
  await page.getByRole('tab', { name: tab }).click();
  await page.locator('.msg-subject', { hasText: subject }).first().click();
  await frame().getByText('Your account').waitFor();
};
await page.context().route(/https:\/\/(evil|www\.mybank)\.example\//, (r) => r.fulfill({ contentType: 'text/html', body: '<title>Landed</title>landed' }));
await step('a link whose text shows another address is flagged above the email and asks before opening', async () => {
  const st = await putHtml('Verify your account', '<p>Your account needs checking.</p><p><a href="https://evil.example/login">www.mybank.example</a></p><p><a href="https://www.mybank.example/help">Help centre</a> · <a href="https://www.mybank.example/terms">mybank.example/terms</a></p>');
  if (st >= 300) throw new Error(`upload ${st}`);
  await openMsg('Verify your account');
  await page.locator('.mail-reader').getByText('Careful: a link in this email goes somewhere other than it says.').waitFor();
  await page.locator('.mail-reader').getByText(/“www\.mybank\.example” goes to evil\.example/).waitFor();
  await axe(page, 'link banner');
  await frame().getByRole('link', { name: 'www.mybank.example' }).click();
  const ask = page.getByRole('dialog', { name: 'This link goes somewhere else' });
  await ask.getByText('evil.example', { exact: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/linkwarn.png` });
  await axe(page, 'link dialog');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await ask.waitFor({ state: 'detached' });
  if (page.context().pages().length !== 1) throw new Error('opened without asking');
  const [pop] = await Promise.all([page.waitForEvent('popup'), (async () => {
    await frame().getByRole('link', { name: 'www.mybank.example' }).click();
    await ask.getByRole('button', { name: 'Open anyway' }).click();
  })()]);
  await pop.waitForLoadState();
  if (!pop.url().startsWith('https://evil.example/login')) throw new Error(pop.url());
  await pop.close();
});
await step('honest links open straight away', async () => {
  const [pop] = await Promise.all([page.waitForEvent('popup'), frame().getByRole('link', { name: 'mybank.example/terms' }).click()]);
  if (!pop.url().startsWith('https://www.mybank.example/terms')) throw new Error(pop.url());
  await pop.close();
  if (await page.getByRole('dialog').count()) throw new Error('asked about an honest link');
});
await step('a newsletter (its links pass through a click counter) asks on click but has no banner', async () => {
  const st = await putHtml('Monthly news', '<p>Your account news.</p><p><a href="https://evil.example/click?u=1">www.mybank.example</a></p>', 'List-Unsubscribe: <https://www.mybank.example/unsub>\r\n');
  if (st >= 300) throw new Error(`upload ${st}`);
  await openMsg('Monthly news', 'Updates'); // a newsletter goes to Updates
  if (await page.locator('.mail-reader').getByText(/goes somewhere other than/).count()) throw new Error('banner on a newsletter');
  await frame().getByRole('link', { name: 'www.mybank.example' }).click();
  await page.getByRole('dialog', { name: 'This link goes somewhere else' }).getByRole('button', { name: 'Cancel' }).click();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
