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

const body = () => page.getByRole('textbox', { name: 'Message' });
const pop = () => page.getByRole('dialog', { name: 'Emoji' });
await step('search and insert at the cursor; typing carries on after it', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('olivia@acme.com');
  await page.getByLabel('Subject').fill('Emoji test');
  await body().click();
  await page.keyboard.type('Hello  there');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: 'Insert emoji' }).click();
  await page.getByLabel('Search emoji').fill('thu up');
  await pop().getByText('1 found').waitFor();
  await page.screenshot({ path: `${SP}/shots/emoji-search.png` });
  await page.keyboard.press('Enter');
  await page.keyboard.type('!');
  const t = await body().innerText();
  if (t.trim() !== 'Hello 👍! there') throw new Error(JSON.stringify(t));
  if (await page.getByRole('dialog', { name: 'New message' }).count() === 0 && await page.locator('.compose').count() === 0) throw new Error('compose closed');
});

await step('keyboard: groups, arrows, Enter; Escape closes only the popup; recent first', async () => {
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Insert emoji' }).click();
  await pop().getByRole('tab', { name: 'Recent', selected: true }).waitFor();
  await pop().getByRole('gridcell', { name: 'thumbs up' }).waitFor();
  await pop().getByRole('tab', { name: 'Food and drink' }).click();
  await page.getByLabel('Search emoji').focus();
  await page.keyboard.press('ArrowDown'); // first: red apple
  await page.keyboard.press('ArrowDown'); // one row (8) later
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  const name = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  if (name !== 'avocado') throw new Error(name);
  await page.keyboard.press('Enter');
  if ((await body().innerText()).trim() !== 'Hello 👍! there🥑') throw new Error(await body().innerText());
  await page.getByRole('button', { name: 'Insert emoji' }).click();
  await page.keyboard.press('Escape');
  await pop().waitFor({ state: 'detached' });
  await body().waitFor(); // the message is still open
  const recent = await (async () => { await page.getByRole('button', { name: 'Insert emoji' }).click(); return pop().getByRole('grid').getByRole('gridcell').allInnerTexts(); })();
  if (recent.slice(0, 2).join() !== '🥑,👍') throw new Error(recent.join());
  await page.keyboard.press('Escape');
});

await step('emoji arrive in the sent message', async () => {
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  const row = page.locator('.msg-list li', { hasText: 'Emoji test' });
  await refreshUntil(page, row);
  await row.locator('.msg-row').click();
  await page.frameLocator('iframe.mail-html').getByText('Hello 👍! there🥑').waitFor();
});

await step('chat: insert where the cursor is', async () => {
  await page.goto(B + '/chat');
  const box = page.getByLabel('Message', { exact: true });
  await box.fill('Great work');
  await box.press('Home');
  await page.getByRole('button', { name: 'Insert emoji' }).click();
  const p = pop();
  const pb = await p.boundingBox(), bb = await page.getByRole('button', { name: 'Insert emoji' }).boundingBox();
  if (pb.y + pb.height > bb.y + 1) throw new Error('chat popup should open above the box');
  await p.getByRole('tab', { name: 'Activities and travel' }).click();
  await p.getByRole('gridcell', { name: 'party popper' }).click();
  await page.keyboard.type(' ');
  if ((await box.inputValue()) !== '🎉 Great work') throw new Error(await box.inputValue());
  await page.keyboard.press('Enter');
  await page.locator('.msg-text', { hasText: '🎉 Great work' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/emoji-chat.png` });
});

await step('phone width: the popup stays on screen', async () => {
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(B + '/mail');
  await page.getByRole('button', { name: 'Compose' }).click();
  await body().click();
  await page.getByRole('button', { name: 'Insert emoji' }).click();
  const b = await pop().boundingBox();
  if (b.x < 0 || b.x + b.width > 375) throw new Error(JSON.stringify(b));
  await page.screenshot({ path: `${SP}/shots/emoji-phone.png` });
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
