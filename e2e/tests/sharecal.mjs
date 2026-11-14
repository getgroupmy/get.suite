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
const page = await mk('olivia');
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const chip = (p, t) => p.locator('.chip', { hasText: t });
let kim, lee;
const monthView = async (p) => { await p.goto(`${B}/calendar`); await p.getByRole('button', { name: 'Month', exact: true }).or(p.getByRole('radio', { name: 'Month', exact: true })).first().click(); };
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
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  lee = await mk('lee'); await signIn(lee, 'lee@acme.com');
  const cal = (await api(page, 'POST', '/events/calendars', { name: 'Team holidays', color: '#0b8043' })).body;
  const t = new Date(); t.setHours(9, 0, 0, 0);
  await api(page, 'POST', '/events', { title: 'Olivia away', start: t.getTime(), end: t.getTime() + 3600e3, calendar_id: cal.id, color: '#0b8043' });
  await api(page, 'POST', '/events', { title: 'Private dentist', start: t.getTime(), end: t.getTime() + 3600e3 });
  await monthView(page);
});
await step('share it: Kim sees events, Lee can make changes', async () => {
  await page.getByRole('button', { name: 'Options for Team holidays' }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const d = page.getByRole('dialog', { name: 'Share “Team holidays”' });
  await d.getByLabel('Share with a colleague').selectOption({ label: 'Kim Park' });
  await d.getByLabel('What Kim Park can do').waitFor();
  await d.getByLabel('Share with a colleague').selectOption({ label: 'Lee Chan' });
  await d.getByLabel('What Lee Chan can do').selectOption('edit');
  await until(async () => { const c = (await api(page, 'GET', '/events/calendars')).body[0]; return c.members.length === 2 && c.members.find((m) => m.name === 'Lee Chan')?.can_edit; });
  await page.screenshot({ path: `${SP}/shots/sharecal.png` });
  await d.getByRole('button', { name: 'Done' }).click();
});
await step('Kim finds it under Shared with me, sees its events (not Olivia\'s others), read-only', async () => {
  await monthView(kim);
  await kim.getByRole('list', { name: 'Calendars shared with me' }).getByText('Team holidays').waitFor();
  await chip(kim, 'Olivia away').first().waitFor();
  if (await chip(kim, 'Private dentist').count()) throw new Error('only the shared calendar');
  await chip(kim, 'Olivia away').first().click();
  const d = kim.getByRole('dialog', { name: 'Olivia away' });
  await d.getByText('which Olivia Owner shares with you to see').waitFor();
  if (await d.getByRole('button', { name: 'Save' }).count()) throw new Error('read-only');
  await kim.keyboard.press('Escape');
  // Hiding it is Kim's own choice.
  await kim.getByRole('checkbox', { name: 'Show Team holidays' }).uncheck();
  await until(async () => (await chip(kim, 'Olivia away').count()) === 0);
});
await step('Lee changes the event and adds one; Olivia sees both live and is told', async () => {
  await monthView(lee);
  await chip(lee, 'Olivia away').first().click();
  const d = lee.getByRole('dialog', { name: 'Edit event' });
  await d.getByLabel('Title').fill('Olivia away (morning)');
  await d.getByRole('button', { name: 'Save' }).click();
  await chip(page, 'Olivia away (morning)').first().waitFor();
  await lee.getByRole('button', { name: 'Create' }).click();
  const n = lee.getByRole('dialog', { name: 'New event' });
  await n.getByLabel('Title').fill('Lee away');
  await n.getByLabel('Calendar', { exact: true }).selectOption({ label: 'Team holidays (Olivia Owner)' });
  await n.getByRole('button', { name: 'Save' }).click();
  await chip(page, 'Lee away').first().waitFor();
  await chip(lee, 'Lee away').first().waitFor();
  const mine = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 864e5}`)).body.find((e) => e.title === 'Lee away');
  if (mine.role !== 'organizer' || !mine.calendar_id) throw new Error('Lee\'s event is in Olivia\'s calendar');
  const bell = JSON.stringify((await api(page, 'GET', '/notifications')).body);
  if (!bell.includes('Lee Chan added “Lee away” in Team holidays')) throw new Error(bell.slice(0, 300));
});
await step('stopping sharing takes it away from Kim', async () => {
  await page.getByRole('button', { name: 'Options for Team holidays' }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const d = page.getByRole('dialog', { name: 'Share “Team holidays”' });
  await d.getByRole('button', { name: 'Stop sharing with Kim Park' }).click();
  await d.getByRole('button', { name: 'Done' }).click();
  await kim.getByRole('list', { name: 'Calendars shared with me' }).waitFor({ state: 'detached' });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
