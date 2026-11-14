import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import fs from 'node:fs';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(m.text()));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const chip = (t) => page.locator('.chip', { hasText: t });
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
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Month', exact: true }).or(page.getByRole('radio', { name: 'Month', exact: true })).first().click();
});
await step('add a calendar of your own with its colour', async () => {
  await page.getByRole('button', { name: 'Add a calendar' }).click();
  const d = page.getByRole('dialog', { name: 'New calendar' });
  await d.getByLabel('Name').fill('Family');
  await d.getByRole('radio', { name: '#8e24aa' }).click();
  await d.getByRole('button', { name: 'Add calendar' }).click();
  await page.getByRole('checkbox', { name: 'Show Family' }).waitFor();
  if (!(await page.getByRole('checkbox', { name: 'Show Family' }).isChecked())) throw new Error('shown at first');
});
await step('an event put in it takes its colour', async () => {
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('School play');
  await dlg.getByLabel('Calendar', { exact: true }).selectOption({ label: 'Family' });
  if ((await dlg.getByRole('radio', { name: '#8e24aa' }).getAttribute('aria-checked')) !== 'true') throw new Error('colour follows the calendar');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await chip('School play').first().waitFor();
  await page.getByRole('button', { name: 'Create' }).click();
  const d2 = page.getByRole('dialog', { name: 'New event' });
  await d2.getByLabel('Title').fill('Budget review');
  await d2.getByRole('button', { name: 'Save' }).click();
  await chip('Budget review').first().waitFor();
  const list = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 2 * 864e5}`)).body;
  const cal = (await api(page, 'GET', '/events/calendars')).body[0];
  const play = list.find((e) => e.title === 'School play'), budget = list.find((e) => e.title === 'Budget review');
  if (play.calendar_id !== cal.id || play.color !== '#8e24aa' || budget.calendar_id !== null) throw new Error(JSON.stringify([play.calendar_id, play.color, budget.calendar_id]));
  await page.screenshot({ path: `${SP}/shots/mycals.png` });
});
await step('unticking a calendar hides its events, and stays so after reloading', async () => {
  await page.getByRole('checkbox', { name: 'Show Family' }).uncheck();
  await until(async () => (await chip('School play').count()) === 0);
  if (!(await chip('Budget review').count())) throw new Error('the main calendar stays');
  await page.reload();
  await chip('Budget review').first().waitFor();
  if (await chip('School play').count()) throw new Error('still hidden after reload');
  await page.getByRole('checkbox', { name: 'Show Family' }).check();
  await chip('School play').first().waitFor();
});
await step('recolouring the calendar recolours its events', async () => {
  await page.getByRole('button', { name: 'Options for Family' }).click();
  await page.getByRole('menuitem', { name: 'Name and colour…' }).click();
  const d = page.getByRole('dialog', { name: 'Calendar' });
  await d.getByLabel('Name').fill('Home');
  await d.getByRole('radio', { name: '#0b8043' }).click();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('checkbox', { name: 'Show Home' }).waitFor();
  await until(async () => /11, 128, 67|0b8043/i.test(await chip('School play').first().getAttribute('style')));
});
await step('move an event to another calendar in its window', async () => {
  await chip('Budget review').first().click();
  const d = page.getByRole('dialog', { name: 'Edit event' });
  await d.getByLabel('Calendar', { exact: true }).selectOption({ label: 'Home' });
  if ((await d.getByRole('radio', { name: '#0b8043' }).getAttribute('aria-checked')) !== 'true') throw new Error('takes Home\'s colour');
  await d.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 2 * 864e5}`)).body.find((e) => e.title === 'Budget review')?.calendar_id);
});
await step('download it, then delete it keeping its events', async () => {
  await page.getByRole('button', { name: 'Options for Home' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download (.ics)' }).click()]);
  const file = `${SP}/home.ics`;
  await dl.saveAs(file);
  const ics = fs.readFileSync(file, 'utf8');
  if (!/X-WR-CALNAME:Home/.test(ics) || !/SUMMARY:School play/.test(ics) || !/SUMMARY:Budget review/.test(ics)) throw new Error(ics.slice(0, 300));
  await page.getByRole('button', { name: 'Options for Home' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const d = page.getByRole('dialog', { name: 'Delete Home?' });
  await d.getByText('It has 2 events').waitFor();
  await d.getByRole('button', { name: 'Keep its events' }).click();
  await page.getByRole('checkbox', { name: 'Show Home' }).waitFor({ state: 'detached' });
  await chip('School play').first().waitFor();
  const list = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 2 * 864e5}`)).body;
  if (list.some((e) => e.calendar_id)) throw new Error('moved to the main calendar');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
