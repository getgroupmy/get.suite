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
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});

const looks = (loc) => loc.evaluate((el) => getComputedStyle(el).listStyleType);
await step('compose: a numbered list in i. ii. iii., a bulleted one with ✓', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Agenda');
  await page.getByRole('textbox', { name: 'Message' }).click();
  await page.keyboard.type('Agenda:');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Numbered list' }).click();
  await page.keyboard.type('Welcome');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Budget');
  if (await page.getByLabel('Numbering style').inputValue() !== 'decimal') throw new Error('starts as 1.');
  await page.getByLabel('Numbering style').selectOption({ label: 'i. ii. iii.' });
  await page.locator('.compose-editor li', { hasText: 'Budget' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); // out of the list
  await page.keyboard.type('Done:');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Bulleted list' }).click();
  await page.keyboard.type('Minutes sent');
  await page.getByLabel('Bullet style').selectOption({ label: '✓ Tick' });
  if (await looks(page.locator('.compose-editor ol')) !== 'lower-roman') throw new Error('ol');
  if (await looks(page.locator('.compose-editor ul')) !== '"✓ "') throw new Error('ul');
  await page.screenshot({ path: `${SP}/shots/mail-list-styles.png` });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
});
const gina = await mk('gina');
await step('Gina sees them so in the message', async () => {
  await signIn(gina, 'gina@globex.com');
  const row = gina.locator('.msg-list li', { hasText: 'Agenda' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const frame = gina.frameLocator('iframe.mail-html');
  await frame.locator('li', { hasText: 'Budget' }).waitFor();
  if (await looks(frame.locator('ol')) !== 'lower-roman') throw new Error('ol');
  if (await looks(frame.locator('ul')) !== '"✓ "') throw new Error('ul');
  const uid = Number(gina.url().split('/').pop());
  const msg = (await api(gina, 'GET', `/mail/messages/${uid}?folder=INBOX`)).body;
  if (!msg.text.includes('i. Welcome\nii. Budget')) throw new Error('plain-text part: ' + JSON.stringify(msg.text));
}, gina);
await step('…and forwarding keeps them in the message she writes', async () => {
  await gina.getByRole('button', { name: 'Forward', exact: true }).click();
  const ol = gina.locator('.compose-editor ol', { hasText: 'Budget' });
  await ol.waitFor();
  if (await looks(ol) !== 'lower-roman') throw new Error(`ol: ${await looks(ol)}`);
  if (await looks(gina.locator('.compose-editor ul', { hasText: 'Minutes sent' })) !== '"✓ "') throw new Error('ul');
}, gina);
await step('⋮ → Save to Drive as a document: an editable document with its lists as they look', async () => {
  await gina.keyboard.press('Escape').catch(() => {});
  await gina.goto(`${B}/mail`);
  const row = gina.locator('.msg-list li', { hasText: 'Agenda' }).first();
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  await gina.getByRole('button', { name: 'More for this message' }).click();
  await gina.getByRole('menuitem', { name: 'Save to Drive as a document' }).click();
  await gina.getByText(/^Saved to Drive: Saved emails \/ Agenda \(\d{4}-\d\d-\d\d\)$/).waitFor();
  await gina.getByRole('button', { name: 'Open', exact: true }).click();
  await gina.waitForURL(/\/docs\//);
  const ed = gina.locator('.paper .tiptap');
  await ed.locator('h2', { hasText: 'Agenda' }).waitFor();
  await ed.getByText(/^From:/).waitFor();
  const ol = ed.locator('ol', { hasText: 'Budget' });
  if (await looks(ol) !== 'lower-roman') throw new Error(`ol: ${await looks(ol)}`);
  if (await looks(ed.locator('ul', { hasText: 'Minutes sent' })) !== '"✓ "') throw new Error('ul');
}, gina);
await step('Docs ⋮ → Send as email: the document is the email, its lists and picture with it', async () => {
  const picId = await page.evaluate(async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=dot.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: png });
    return (await r.json()).id;
  });
  const T = (text) => ({ type: 'text', text });
  const content = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [T('Weekly update')] },
    { type: 'paragraph', content: [T('Where we are:')] },
    { type: 'orderedList', attrs: { start: 1, listStyle: 'upper-alpha' }, content: ['Hiring', 'Office move'].map((t) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [T(t)] }] })) },
    { type: 'image', attrs: { fileId: picId, alt: 'Team photo' } },
  ] };
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Weekly update', content })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.paper .tiptap li', { hasText: 'Office move' }).waitFor();
  await page.locator('.paper .tiptap img[alt="Team photo"]').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send as email' }).click();
  await page.waitForURL(/\/mail/);
  const ed = page.locator('.compose-editor');
  await ed.locator('li', { hasText: 'Office move' }).waitFor();
  if (await page.getByLabel('Subject').inputValue() !== 'Weekly update') throw new Error('subject');
  const title = ed.locator('span', { hasText: 'Weekly update' });
  if (await title.evaluate((el) => getComputedStyle(el).fontSize) !== '24px') throw new Error('the title as Huge bold text');
  if (await looks(ed.locator('ol')) !== 'upper-alpha') throw new Error(`ol: ${await looks(ed.locator('ol'))}`);
  await ed.locator('img[alt="Team photo"]').waitFor();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  // Gina gets it as written, the picture inside the email.
  await gina.goto(`${B}/mail`);
  const row = gina.locator('.msg-list li', { hasText: 'Weekly update' }).first();
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const frame = gina.frameLocator('iframe.mail-html');
  await frame.locator('li', { hasText: 'Office move' }).waitFor();
  if (await looks(frame.locator('ol')) !== 'upper-alpha') throw new Error('received ol');
  const img = frame.locator('img[alt="Team photo"]');
  await img.waitFor();
  if (!(await img.evaluate((el) => el.complete && el.naturalWidth === 1))) throw new Error('picture not shown: ' + await img.getAttribute('src'));
});
await step('Sheets ⋮ → Send as email: the sheet as a table in the email, values and look as shown', async () => {
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Quote', content: { sheets: [{ name: 'Sheet1', colWidths: {},
    cells: { A1: 'Item', B1: 'Price', C1: 'Cost code', A2: 'Bolts', B2: '1.5', C2: 'x', A3: 'Nuts', B3: '2', A4: 'Total', B4: '=B2+B3' },
    formats: { A1: { b: true }, B1: { b: true }, B2: { num: 'currency', cur: 'USD', dp: 2 }, B3: { num: 'currency', cur: 'USD', dp: 2 }, B4: { num: 'currency', cur: 'USD', dp: 2, b: true, color: '#c00000' } }, hide: { cols: [2] } }] } })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.locator('[data-k="B4"]', { hasText: '$3.50' }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Send as email' }).click();
  await page.waitForURL(/\/mail/);
  const ed = page.locator('.compose-editor');
  const total = ed.locator('td', { hasText: '$3.50' });
  await total.waitFor();
  if (await page.getByLabel('Subject').inputValue() !== 'Quote') throw new Error('subject');
  const rows = await ed.locator('table tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent).join('|')));
  if (JSON.stringify(rows) !== JSON.stringify(['Item|Price', 'Bolts|$1.50', 'Nuts|$2.00', 'Total|$3.50'])) throw new Error('rows: ' + JSON.stringify(rows));
  const look = await total.locator('span').evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el.querySelector('strong') || el).fontWeight]);
  if (look[0] !== 'rgb(192, 0, 0)' || Number(look[1]) < 600) throw new Error('look: ' + look);
  await page.getByRole('textbox', { name: 'Message' }).locator('p').first().click();
  await page.keyboard.type('Here is the quote:');
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  await gina.goto(`${B}/mail`);
  const row = gina.locator('.msg-list li', { hasText: 'Quote' }).first();
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const frame = gina.frameLocator('iframe.mail-html');
  await frame.getByText('Here is the quote:').waitFor();
  const got = await frame.locator('table tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent).join('|')));
  if (JSON.stringify(got) !== JSON.stringify(rows)) throw new Error('received: ' + JSON.stringify(got));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
