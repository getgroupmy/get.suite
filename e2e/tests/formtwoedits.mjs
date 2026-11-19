// Two people editing one form at the same moment, each a different question: both changes are kept (the
// form's questions are merged one by one, not replaced wholesale by whoever saves last).
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const found = [];
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

await step('question 1 edited here while question 2 is edited elsewhere: both kept', async () => {
  const f = (await api('POST', '/forms', { title: 'Team survey', questions: [{ type: 'short', title: 'Your name' }, { type: 'short', title: 'Your team' }] })).body;
  await page.goto(`${B}/forms/${f.id}`);
  const q1 = page.getByLabel('Question 1 title');
  await q1.waitFor();
  const qs = (await api('GET', `/forms/${f.id}`)).body.questions;
  await q1.fill('Your full name');
  // a colleague's change to question 2 lands while this one is waiting to be saved
  const r = await api('PUT', `/forms/${f.id}`, { questions: [qs[0], { ...qs[1], title: 'Your team or department' }] });
  if (r.status !== 200) throw new Error(`elsewhere: ${r.status}`);
  await page.waitForTimeout(2500);
  const now = (await api('GET', `/forms/${f.id}`)).body.questions.map((x) => x.title);
  console.log('now', JSON.stringify(now));
  if (now[0] !== 'Your full name') found.push(`question 1: “${now[0]}”`);
  if (now[1] !== 'Your team or department') found.push(`question 2 (changed elsewhere): “${now[1]}”`);
  // and the page shows both
  await page.getByLabel('Question 2 title').evaluate((el) => el.value).then((v) => { if (v !== 'Your team or department') found.push(`the page shows question 2 as “${v}”`); });
});

await step('a question added elsewhere while one is edited here: kept', async () => {
  const f = (await api('POST', '/forms', { title: 'Lunch order', questions: [{ type: 'short', title: 'Name' }] })).body;
  await page.goto(`${B}/forms/${f.id}`);
  const q1 = page.getByLabel('Question 1 title');
  await q1.waitFor();
  const qs = (await api('GET', `/forms/${f.id}`)).body.questions;
  await q1.fill('Name and desk');
  await api('PUT', `/forms/${f.id}`, { questions: [...qs, { type: 'short', title: 'Allergies' }] });
  await page.waitForTimeout(2500);
  const now = (await api('GET', `/forms/${f.id}`)).body.questions.map((x) => x.title);
  console.log('now', JSON.stringify(now));
  if (JSON.stringify(now) !== JSON.stringify(['Name and desk', 'Allergies'])) found.push(`added elsewhere: ${JSON.stringify(now)}`);
});

await step('nothing lost', async () => { if (found.length) throw new Error(found.join(' | ')); });
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
