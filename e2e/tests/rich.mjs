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

await step('compose-rich-text', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Order summary');
  const body = page.getByRole('textbox', { name: 'Message' });
  await body.click();
  await page.keyboard.type('Hi Gina, here is the ');
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type('final');
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.keyboard.type(' order:');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Bulleted list' }).click();
  await page.keyboard.type('500 bolts');
  await page.keyboard.press('Enter');
  await page.keyboard.type('200 nuts');
  await page.screenshot({ path: `${SP}/shots/rich-compose.png` });
  await page.locator('.draft-state', { hasText: 'Draft saved' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Close' }).click();
  // Reopen the draft: formatting survives.
  await page.getByRole('button', { name: /^Drafts/ }).click();
  await page.locator('.msg-list li', { hasText: 'Order summary' }).locator('.msg-row').click();
  await page.locator('.compose-editor strong', { hasText: 'final' }).waitFor();
  await page.locator('.compose-editor li', { hasText: '200 nuts' }).waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
});

const gina = await mk('gina');
await step('recipient-sees-formatting', async () => {
  await signIn(gina, 'gina@globex.com');
  const row = gina.locator('.msg-list li', { hasText: 'Order summary' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const frame = gina.frameLocator('iframe.mail-html');
  await frame.locator('strong', { hasText: 'final' }).waitFor();
  await frame.locator('li', { hasText: '500 bolts' }).waitFor();
  const uid = Number(gina.url().split('/').pop());
  const msg = (await api(gina, 'GET', `/mail/messages/${uid}?folder=INBOX`)).body;
  if (!msg.text.includes('- 500 bolts\n- 200 nuts')) throw new Error('plain-text part: ' + JSON.stringify(msg.text));
  await gina.screenshot({ path: `${SP}/shots/rich-received.png` });
}, gina);

await step('reply-quotes-original', async () => {
  await gina.getByRole('button', { name: 'Reply', exact: true }).click();
  await gina.locator('.compose-editor blockquote', { hasText: '500 bolts' }).waitFor();
  await gina.keyboard.type('Confirmed, shipping Monday.');
  await gina.getByRole('button', { name: 'Send', exact: true }).click();
  await gina.getByText('Sent to 1 recipient').waitFor();
}, gina);

await step('filter-from-message', async () => {
  const row = page.locator('.msg-list li', { hasText: 'Re: Order summary' });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await refreshUntil(page, row);
  await row.locator('.msg-row').click();
  await page.frameLocator('iframe.mail-html').getByText('Confirmed, shipping Monday.').waitFor();
  await page.getByRole('button', { name: 'Filter messages like this' }).click();
  await page.getByRole('textbox', { name: 'Condition 1 value' }).waitFor();
  if ((await page.getByRole('textbox', { name: 'Condition 1 value' }).inputValue()) !== 'gina@globex.com') throw new Error('not prefilled');
  await page.getByLabel('Move to').check();
  await page.getByLabel('Folder').selectOption('__new__');
  await page.getByLabel('New folder name').fill('Partners/Globex');
  await page.getByLabel('Mark as read').check();
  await page.screenshot({ path: `${SP}/shots/filter-editor.png` });
  await page.getByRole('button', { name: 'Save filter' }).click();
  await page.locator('.toast', { hasText: 'Filter saved' }).waitFor();
  await page.getByRole('button', { name: /^Partners \/ Globex( \d+)?$/ }).waitFor();
});

await step('filter-applies-on-delivery', async () => {
  await gina.waitForTimeout(3000); // mail server loads the new rules
  const r = await api(gina, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Invoice 7781', text: 'Please pay.' });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  await page.getByRole('button', { name: /^Partners \/ Globex( \d+)?$/ }).click();
  const row = page.locator('.msg-list li', { hasText: 'Invoice 7781' });
  await refreshUntil(page, row);
  if (await row.evaluate((el) => el.classList.contains('unread'))) throw new Error('not marked read');
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(500);
  if (await page.locator('.msg-list li', { hasText: 'Invoice 7781' }).count()) throw new Error('also in Inbox');
});

await step('filters-list-toggle-delete', async () => {
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByText('If From contains “gina@globex.com”: move to Partners/Globex, mark as read').waitFor();
  await page.screenshot({ path: `${SP}/shots/filters-list.png` });
  await page.getByRole('checkbox', { name: /Turn .* off/ }).click();
  await page.locator('.rule-list li.dim').waitFor();
  const rules = (await api(page, 'GET', '/mail/rules')).body;
  if (rules[0].enabled !== false) throw new Error('not disabled');
  await page.getByRole('button', { name: /^Delete / }).click();
  await page.getByText('No filters yet.').waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
