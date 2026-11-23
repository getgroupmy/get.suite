import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
const cardOf = (name) => page.getByRole('article', { name });
let note;
await step('labels on other notes; a note without any', async () => {
  for (const [title, labels] of [['Office plants', ['Work']], ['Groceries', ['Home']], ['Rome trip', ['Travel', 'Trips abroad']]]) {
    const n = (await api(page, 'POST', '/notes', { title, body: 'x' })).body;
    if ((await api(page, 'PATCH', `/notes/${n.id}`, { labels })).status !== 200) throw new Error('labels');
  }
  note = (await api(page, 'POST', '/notes', { title: 'Seed list', body: 'tomatoes' })).body;
});
await step('Labels…: typing narrows the labels, Enter ticks the one left, and a new name is made from the same box', async () => {
  await page.goto(`${B}/notes`);
  await cardOf('Seed list').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Labels…' }).click();
  const d = page.getByRole('dialog', { name: 'Labels' });
  const box = d.getByLabel('Find or make a label');
  await box.fill('TRAV');
  await until(async () => (await d.getByRole('checkbox').count()) === 1);
  await d.getByRole('checkbox', { name: 'Travel' }).waitFor();
  await box.press('Enter');
  if (await box.inputValue()) throw new Error('box not emptied');
  if (!(await d.getByRole('checkbox', { name: 'Travel' }).isChecked())) throw new Error('Travel not ticked');
  if ((await d.getByRole('checkbox').count()) < 4) throw new Error('the list did not come back');
  await box.fill('Garden');
  await d.getByRole('button', { name: '+ Make label “Garden”' }).waitFor();
  await box.press('Enter');
  if (!(await d.getByRole('checkbox', { name: 'Garden' }).isChecked())) throw new Error('Garden not made and ticked');
  await box.fill('work');
  if (await d.getByRole('button', { name: /Make label/ }).count()) throw new Error('offered to make a label that exists');
  await box.fill('');
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await until(async () => {
    const n = (await api(page, 'GET', '/notes')).body.find((x) => x.id === note.id);
    return n && [...n.labels].sort().join(',') === 'Garden,Travel';
  });
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
