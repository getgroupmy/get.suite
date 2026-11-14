import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64'); // 64x32
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
const ed = (p) => p.locator('.compose-editor .tiptap');

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

await step('resize-picture-and-keep-size-in-draft', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Sized picture');
  await ed(page).click();
  await page.keyboard.type('Half width below:');
  await page.keyboard.press('Enter');
  await page.getByLabel('Picture file').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: PNG });
  const img = ed(page).locator('img');
  await img.waitFor();
  if (await page.getByRole('group', { name: 'Picture size' }).count()) throw new Error('size bar shown without a selected picture');
  await img.click();
  await page.getByRole('group', { name: 'Picture size' }).waitFor();
  await page.getByRole('button', { name: /^Medium picture/ }).click();
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap .img-wrap')?.getAttribute('data-width') === '50');
  const ratio = await page.evaluate(() => {
    const i = document.querySelector('.compose-editor .tiptap img');
    const ed = document.querySelector('.compose-editor .tiptap');
    const cs = getComputedStyle(ed);
    return i.getBoundingClientRect().width / (ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  });
  if (Math.abs(ratio - 0.5) > 0.05) throw new Error(`shown at ${Math.round(ratio * 100)}%`);
  await page.screenshot({ path: `${SP}/shots/resize.png` });
  await page.locator('.draft-state', { hasText: 'Draft saved' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: /^Drafts/ }).click();
  await page.locator('.msg-list li', { hasText: 'Sized picture' }).locator('.msg-row').click();
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap .img-wrap')?.getAttribute('data-width') === '50');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
});

const gina = await mk('gina');
await step('recipient-sees-half-width', async () => {
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.getByRole('link', { name: 'Mail' }).click();
  const row = gina.locator('.msg-list li', { hasText: 'Sized picture' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const frame = gina.frameLocator('iframe.mail-html');
  await frame.locator('img').waitFor();
  const ratio = await frame.locator('img').evaluate((i) => i.getBoundingClientRect().width / i.parentElement.getBoundingClientRect().width);
  if (Math.abs(ratio - 0.5) > 0.05) throw new Error(`recipient sees ${Math.round(ratio * 100)}%`);
}, gina);

await step('follow-a-folder', async () => {
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel(/Folder name/).fill('Suppliers');
  await page.getByRole('button', { name: 'Create' }).click();
  await api(page, 'PUT', '/mail/rules', { rules: [{ name: 'Suppliers', conditions: [{ field: 'subject', op: 'contains', value: '[supplier]' }], actions: { moveTo: 'Suppliers' } }] });
  await page.getByRole('button', { name: 'Options for Suppliers' }).click();
  await page.getByRole('menuitem', { name: 'Notify me about new mail' }).click();
  await page.locator('.toast', { hasText: "You'll be notified about new mail in Suppliers" }).waitFor();
  await page.locator('.folder-row', { hasText: 'Suppliers' }).locator('.icon.followed').waitFor();
});

await step('alert-names-the-folder-and-badge-counts-it', async () => {
  await page.goto(B + '/calendar');
  await page.waitForTimeout(4000); // live connection, watchers and the new filter are ready
  await api(gina, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: '[supplier] Invoice 9001', text: 'Due in 30 days.' });
  await page.locator('.toast', { hasText: 'New mail in Suppliers from Gina Globex: [supplier] Invoice 9001' }).waitFor({ timeout: 10000 });
  await page.locator('.appnav .nav-badge', { hasText: '1' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/folder-alert.png` });
});

await step('stop-following', async () => {
  await page.getByRole('link', { name: /Mail/ }).click();
  await page.getByRole('button', { name: 'Options for Suppliers' }).click();
  await page.getByRole('menuitem', { name: 'Stop notifications' }).click();
  await page.locator('.toast', { hasText: 'No more notifications for Suppliers' }).waitFor();
  if (await page.locator('.folder-row', { hasText: 'Suppliers' }).locator('.icon.followed').count()) throw new Error('bell still shown');
  await page.waitForFunction(() => !document.querySelector('.appnav .nav-badge'), null, { timeout: 10000 }); // Suppliers no longer counted
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
