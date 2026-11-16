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
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|409|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const upload = (name, text) => page.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text]);
let folder = 'INBOX';
await step('an email with a disguised program, an Office file with macros and a photo', async () => {
  const a = await upload('scan.pdf', 'MZ this is really a program');
  const b = await upload('Q3 figures.xlsm', 'PK not really');
  const c = await upload('photo.txt', 'just a note');
  const r = await api(page, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Invoice attached', text: 'Please see the invoice.', attachments: [a.id, b.id, c.id] });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  await until(async () => {
    for (const f of ['INBOX', 'Junk']) if (((await api(page, 'GET', `/mail/messages?folder=${f}`)).body?.messages || []).some((m) => m.subject === 'Invoice attached')) { folder = f; return true; }
    return false;
  }, 30000);
  await page.goto(`${B}/mail/${encodeURIComponent(folder)}`);
  await page.locator('.msg-subject', { hasText: 'Invoice attached' }).first().click();
  await page.locator('.mail-reader').getByText('Please see the invoice.').waitFor();
});
await step('risky ones are marked; downloading asks first, and only goes ahead once ticked', async () => {
  const reader = page.locator('.mail-reader');
  await reader.getByRole('img', { name: 'May be harmful' }).waitFor();
  await reader.getByRole('img', { name: 'Be careful' }).waitFor();
  await reader.locator('.att', { hasText: 'scan.pdf' }).click();
  const d = page.getByRole('dialog', { name: 'This attachment may be harmful' });
  await d.getByText(/Windows program, although its name says \.pdf/).waitFor();
  await page.screenshot({ path: `${SP}/shots/attrisk.png` });
  await axe(page, 'risk dialog');
  if (!(await d.getByRole('button', { name: 'Download anyway' }).isDisabled())) throw new Error('should wait for the tick');
  await d.getByLabel('I understand the risk and want to download it').check();
  const dl = d.getByRole('link', { name: 'Download anyway' });
  const [download] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  if (download.suggestedFilename() !== 'scan.pdf') throw new Error(download.suggestedFilename());
  await d.waitFor({ state: 'detached' });
  // The macro file: a warning, not a danger.
  await reader.locator('.att', { hasText: 'Q3 figures.xlsm' }).click();
  await page.getByRole('dialog', { name: 'Be careful with this attachment' }).getByText(/macros/).waitFor();
  await page.getByRole('button', { name: 'Don’t download' }).click();
  // A harmless one opens as before, no question asked.
  await reader.locator('.att', { hasText: 'photo.txt' }).click();
  if (await page.getByRole('dialog', { name: /harmful|careful/ }).count()) throw new Error('asked about a harmless file');
  await page.keyboard.press('Escape');
  // Download all (.zip) asks too, listing each.
  await reader.getByRole('link', { name: 'Download all (.zip)' }).click();
  const all = page.getByRole('dialog', { name: 'This attachment may be harmful' });
  await all.getByText(/scan\.pdf: /).waitFor();
  await all.getByText(/Q3 figures\.xlsm: /).waitFor();
  await page.getByRole('button', { name: 'Don’t download' }).click();
});
await step('the server holds them back without the confirmation', async () => {
  const m = ((await api(page, 'GET', `/mail/messages?folder=${folder}`)).body.messages).find((x) => x.subject === 'Invoice attached');
  const full = (await api(page, 'GET', `/mail/messages/${m.uid}?folder=${folder}`)).body;
  const scan = full.attachments.find((a) => a.filename === 'scan.pdf');
  const status = await page.evaluate(async (u) => (await fetch(u)).status, `/api/mail/messages/${m.uid}/attachments/${scan.index}?folder=${folder}`);
  if (status !== 409) throw new Error(`got ${status}`);
  // Opened straight in a tab (as from a link): a page saying why, not the file.
  await page.goto(`${B}/api/mail/messages/${m.uid}/attachments/${scan.index}?folder=${folder}`);
  await page.getByRole('heading', { name: 'This attachment may be harmful' }).waitFor();
  await page.getByText(/open the email in Workspace Mail/).waitFor();
  await page.goto(`${B}/mail/${encodeURIComponent(folder)}`);
});
await step('in the message list, a risky chip is marked and opens the email instead', async () => {
  const chip = page.getByRole('link', { name: 'Q3 figures.xlsm: may be harmful, open the email' });
  await chip.click();
  await page.locator('.mail-reader').getByText('Please see the invoice.').waitFor();
});
await step('Mail → Attachments marks them and asks before downloading', async () => {
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Attachments' });
  await d.getByLabel('Folder').selectOption(folder);
  const row = d.getByRole('list', { name: 'Attachments' }).locator('li', { hasText: 'Q3 figures.xlsm' });
  await row.getByRole('img', { name: 'Be careful' }).waitFor({ timeout: 20000 });
  await row.getByRole('link', { name: 'Download Q3 figures.xlsm' }).click();
  await page.getByRole('dialog', { name: 'Be careful with this attachment' }).waitFor();
  await page.getByRole('button', { name: 'Don’t download' }).click();
  // scan.pdf looks fine by its name; the server finds out what it is and asks.
  await d.getByRole('list', { name: 'Attachments' }).locator('li', { hasText: 'scan.pdf' }).getByRole('link', { name: 'Download scan.pdf' }).click();
  await page.getByRole('dialog', { name: 'This attachment may be harmful' }).getByText(/Windows program, although its name says \.pdf/).waitFor();
  await page.getByRole('button', { name: 'Don’t download' }).click();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
