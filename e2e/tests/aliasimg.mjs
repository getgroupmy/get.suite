import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHklEQVR42mP8z8Dwn4EIwDiqkL4KGUfDcFQhfRUCAKsBH/F8sJ0zAAAAAElFTkSuQmCC', 'base64');
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
  const a = await api(page, 'POST', '/mail-admin/aliases', { local: 'sales', domain: 'acme.com', targets: 'olivia@acme.com' });
  if (a.status !== 201) throw new Error(JSON.stringify(a));
  await page.reload();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});

await step('signature-per-address', async () => {
  await page.getByRole('button', { name: 'Signature' }).click();
  await page.getByRole('tab', { name: 'olivia@acme.com' }).waitFor();
  await page.getByRole('textbox', { name: 'Signature' }).click();
  await page.keyboard.type('Olivia Owner, Director');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Signature for olivia@acme.com saved' }).waitFor();
  await page.getByRole('tab', { name: 'sales@acme.com' }).click();
  await page.getByRole('textbox', { name: 'Signature' }).click();
  await page.keyboard.type('Acme Sales Team · sales@acme.com');
  await page.screenshot({ path: `${SP}/shots/signature-tabs.png` });
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.toast', { hasText: 'Signature for sales@acme.com saved' }).waitFor();
  await page.getByRole('tab', { name: 'olivia@acme.com' }).click();
  await page.locator('.compose-editor .tiptap', { hasText: 'Olivia Owner, Director' }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
});

await step('switching-from-swaps-signature', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await ed(page).locator('.signature', { hasText: 'Olivia Owner, Director' }).waitFor();
  await page.getByLabel('From', { exact: true }).selectOption('sales@acme.com');
  await ed(page).locator('.signature', { hasText: 'Acme Sales Team' }).waitFor();
  if (await ed(page).getByText('Olivia Owner, Director').count()) throw new Error('old signature still there');
  if ((await ed(page).locator('.signature').count()) !== 1) throw new Error('more than one signature');
});

await step('insert-picture-and-send', async () => {
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Our new catalogue');
  await ed(page).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Here is the cover:');
  await page.keyboard.press('Enter');
  await page.getByLabel('Picture file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
  await ed(page).locator('img[src^="/api/files/"]').waitFor();
  // Paste a screenshot too.
  await ed(page).evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await page.waitForFunction(() => document.querySelectorAll('.compose-editor .tiptap img').length === 2, null, { timeout: 10000 });
  await page.screenshot({ path: `${SP}/shots/compose-images.png` });
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
});

const gina = await mk('gina');
await step('recipient-sees-embedded-pictures', async () => {
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.getByRole('link', { name: 'Mail' }).click();
  const row = gina.locator('.msg-list li', { hasText: 'Our new catalogue' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const f = gina.frameLocator('iframe.mail-html');
  await f.getByText('Here is the cover:').waitFor();
  await f.getByText('Acme Sales Team · sales@acme.com').waitFor();
  const srcs = await f.locator('img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src').slice(0, 22)));
  if (srcs.length !== 2 || !srcs.every((x) => x.startsWith('data:image/png;base64'))) throw new Error(JSON.stringify(srcs));
  const loaded = await f.locator('img').evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth === 16));
  if (!loaded) throw new Error('pictures did not render');
  if (await gina.locator('a.att').count()) throw new Error('pictures listed as attachments');
  if (await gina.getByText('Images from the internet are hidden').count()) throw new Error('embedded pictures treated as remote');
  await gina.screenshot({ path: `${SP}/shots/received-images.png` });
  const r = await api(gina, 'POST', '/mail/send', { to: 'sales@acme.com', subject: 'Re: Our new catalogue', text: 'Lovely, thanks!' });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
}, gina);

await step('reply-uses-the-alias-and-its-signature', async () => {
  const row = page.locator('.msg-list li', { hasText: 'Re: Our new catalogue' });
  await refreshUntil(page, row);
  await row.locator('.msg-row').click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await ed(page).locator('blockquote').waitFor();
  const from = await page.getByLabel('From', { exact: true }).inputValue();
  if (from !== 'sales@acme.com') throw new Error('From = ' + from);
  await ed(page).locator('.signature', { hasText: 'Acme Sales Team' }).waitFor();
  await page.getByRole('button', { name: 'Discard draft' }).click();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
