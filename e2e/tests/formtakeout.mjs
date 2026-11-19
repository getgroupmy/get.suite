// Forms go into Download your data whole (… - form.json): brought into another account, each is a form again, with
// a new link, its questions and its responses (shown in Forms' Responses).
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
let zip;

await step('setup: a form with a response, then Download your data', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api('POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const f = (await api('POST', '/forms', { title: 'Lunch order', questions: [{ id: 'dish', type: 'choice', title: 'Dish', required: true, options: ['Soup', 'Salad'] }] })).body;
  const sent = await api('POST', `/public/forms/${f.token}`, { answers: { dish: 'Salad' } });
  if (sent.status >= 300) throw new Error(`response ${sent.status}`);
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.goto(`${B}/settings`); await page.getByRole('link', { name: /Download your data/ }).first().click(); })()]);
  zip = await (await import('node:fs')).promises.readFile(await dl.path());
  if (!zip.includes('Lunch order - form.json')) throw new Error('no form.json');
});

await step('Kim brings it in: the form is in Forms with its response', async () => {
  await ctx.clearCookies();
  await page.goto(B);
  await page.getByLabel(/Email/).first().fill('kim@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.toast', { hasText: /1 form \(1 response, new links\)/ }).first().waitFor({ timeout: 30000 });
  await page.goto(`${B}/forms`);
  await page.getByText('Lunch order').first().click();
  await page.getByRole('tab', { name: /Responses/ }).first().click();
  await page.getByText('Salad').first().waitFor();
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
