// Signed out while writing (the session ended: a long break, an admin signing everyone out): saving asks you
// to sign in again, and what you wrote isn't lost.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let sheet;

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  sheet = (await api('POST', '/files/new', { kind: 'sheet', name: 'Expiry sheet', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'x' } }] } })).body;
});

await step('a comment written as the session ends: asked to sign in, and the words are kept', async () => {
  await page.goto(`${B}/sheets/${sheet.id}`);
  await page.locator('[data-k="B2"]').click();
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByLabel('New comment').fill('Words written over a long lunch break');
  await ctx.clearCookies(); // the session is over
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SP}/shots/expired.png` });
  const url = page.url();
  const signIn = await page.getByLabel(/Password/).count();
  const box = await page.getByLabel('New comment').count() ? await page.getByLabel('New comment').inputValue() : null;
  console.log(`after: url ${url.replace(B, '')}, sign-in shown: ${signIn > 0}, comment box: ${JSON.stringify(box)}`);
  if (!signIn && box === null) throw new Error('neither asked to sign in nor kept the comment');
  if (box === null) {
    // Asked to sign in (on its own page): signing in brings you back with the words.
    await page.getByLabel(/Email/).first().fill('olivia@acme.com');
    await page.getByLabel(/Password/).first().fill('password123');
    await page.getByRole('button', { name: /Sign in/ }).click();
    await page.waitForTimeout(3000);
    console.log(`after signing in: ${page.url().replace(B, '')}`);
    if (!/\/sheets\//.test(page.url())) throw new Error(`signing in went to ${page.url().replace(B, '')}, not back to the spreadsheet`);
    // Back on the sheet: commenting on the same cell again finds the words waiting.
    await page.locator('[data-k="B2"]').click();
    await page.getByRole('button', { name: 'Add comment' }).click();
    const again = await page.getByLabel('New comment').inputValue();
    if (again !== 'Words written over a long lunch break') throw new Error(`the comment box has “${again}”`);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.getByLabel('New comment').waitFor({ state: 'detached' }); // posted
    for (let k = 0; k < 20 && !JSON.stringify((await api('GET', `/comments/${sheet.id}`)).body).includes('long lunch break'); k++) await page.waitForTimeout(250);
  }
});
await step('posted, the kept words are gone: a new comment on that cell starts empty', async () => {
  await page.reload();
  await page.locator('[data-k="B2"]').click();
  await page.getByRole('button', { name: 'Add comment' }).click();
  const v = await page.getByLabel('New comment').inputValue();
  if (v) throw new Error(`the box has “${v}”`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
