// A task repeating on weeks of the month ("the first and third Monday"): its Repeat says so, and ticking it
// off brings it back on the next such day; quick add makes one from "…the last friday of the month".
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
let list, t;
await step('setup: a task due Monday 2 November, repeating on the first and third Monday', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  list = (await api('POST', '/tasks/lists', { name: 'Admin' })).body;
  t = (await api('POST', `/tasks/lists/${list.id}/tasks`, { title: 'Team report', due: '2026-11-02' })).body;
  const r = await api('PATCH', `/tasks/tasks/${t.id}`, { repeat: 'monthweek:3,1:1' });
  if (r.status !== 200 || r.body.repeat !== 'monthweek:1,3:1') throw new Error(`repeat: ${r.status} ${r.body?.repeat}`);
});

await step('its Repeat reads “Monthly on the first and third Monday”', async () => {
  await page.goto(`${B}/tasks/${list.id}?task=${t.id}`);
  const sel = page.locator('#task-repeat');
  await sel.waitFor();
  const text = await sel.evaluate((el) => el.options[el.selectedIndex].text);
  if (text !== 'Monthly on the first and third Monday') throw new Error(`reads “${text}”`);
});

await step('ticked off: back, due on the next such day (16 November)', async () => {
  await page.clock.setFixedTime(new Date(2026, 10, 3, 9));
  await page.goto(`${B}/tasks/${list.id}`);
  await page.getByRole('checkbox', { name: 'Done: Team report' }).click(); // (it comes straight back, unticked, for the next date)
  await page.waitForTimeout(1500);
  const tasks = (await api('GET', `/tasks/lists/${list.id}/tasks`)).body;
  const open = (tasks.tasks || tasks).filter((x) => x.title === 'Team report' && !x.done);
  if (open.length !== 1 || open[0].due !== '2026-11-16') throw new Error(`open: ${JSON.stringify(open.map((x) => x.due))}`);
});

await step('quick add: “Pay invoices the last friday of the month”', async () => {
  await page.clock.setFixedTime(new Date(2026, 10, 19, 9));
  await page.goto(`${B}/tasks/${list.id}`);
  await page.getByLabel('Add a task').fill('Pay invoices the last friday of the month');
  await page.getByLabel('Add a task').press('Enter');
  await page.waitForTimeout(1500);
  const tasks = (await api('GET', `/tasks/lists/${list.id}/tasks`)).body;
  const x = (tasks.tasks || tasks).find((y) => y.title === 'Pay invoices');
  if (!x || x.due !== '2026-11-27' || x.repeat !== 'monthweek:-1:5') throw new Error(`added as ${JSON.stringify(x && [x.title, x.due, x.repeat])}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
