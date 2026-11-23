import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const style = (k, prop) => cell(k).evaluate((el, p) => getComputedStyle(el)[p], prop);
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
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
});

const until = async (fn, ms = 8000) => { for (let end = Date.now() + ms; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };
await step('Chat: message a colleague by typing a few letters of their name', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['kimberly', 'Kimberly Ortíz']]) if ((await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' })).status !== 201) throw new Error('user');
  await page.goto(`${B}/chat`);
  const box = page.getByLabel('Start a direct message');
  await box.pressSequentially('ortiz'); // accents aside
  const list = page.getByRole('listbox', { name: 'Matching people' });
  await list.getByRole('option').filter({ hasText: 'Kimberly Ortíz' }).waitFor();
  if (await list.getByRole('option').count() !== 1) throw new Error('only Kimberly fits');
  await page.screenshot({ path: `${SP}/shots/chat-dm-pick.png` });
  await box.press('Enter');
  await page.getByRole('heading', { name: /Kimberly Ortíz/ }).first().waitFor();
  if (await box.inputValue() !== '') throw new Error('the box should be empty again');
  await page.getByRole('textbox', { name: /Message/ }).first().waitFor();
});
await step('the conversation is there afterwards; a second one by name', async () => {
  const box = page.getByLabel('Start a direct message');
  await box.pressSequentially('park');
  await page.getByRole('listbox', { name: 'Matching people' }).getByRole('option').filter({ hasText: 'Kim Park' }).click();
  await page.getByRole('heading', { name: /Kim Park/ }).first().waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
