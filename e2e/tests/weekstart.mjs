import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
await step('Week starts on Monday: month, week and year views follow', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  await until(async () => (await page.locator('.month .dow').first().textContent()) === 'Sun');
  await page.getByLabel('Week starts on').selectOption('1');
  await until(async () => (await page.locator('.month .dow').allTextContents()).join(',') === 'Mon,Tue,Wed,Thu,Fri,Sat,Sun');
  const firstDay = await page.locator('.month .day').first().getAttribute('data-day');
  if (new Date(Number(firstDay)).getDay() !== 1) throw new Error('grid starts on a Monday');
  await page.getByRole('radio', { name: 'Week' }).click();
  await until(async () => /^Mon/.test(await page.locator('.tg-dow').first().textContent()));
  await page.getByRole('radio', { name: 'Year' }).click();
  await until(async () => (await page.locator('.year-month').first().locator('.year-dow').allTextContents()).join('') === 'MTWTFSS');
  await page.screenshot({ path: `${SP}/shots/weekstart.png` });
});
await step('Saturday too; remembered after a reload', async () => {
  await page.getByLabel('Week starts on').selectOption('6');
  await page.getByRole('radio', { name: 'Week' }).click();
  await until(async () => /^Sat/.test(await page.locator('.tg-dow').first().textContent()));
  await page.reload();
  if ((await page.getByLabel('Week starts on').inputValue()) !== '6') throw new Error('kept');
  await until(async () => /^Sat/.test(await page.locator('.tg-dow').first().textContent()));
});
await step('printing "This week" starts on the chosen day too', async () => {
  await page.getByRole('button', { name: 'Print or save as PDF' }).click();
  const d = page.getByRole('dialog', { name: 'Print or save as PDF' });
  await d.getByLabel('What to print').selectOption('custom');
  const from = await d.locator('input[type="date"]').first().inputValue();
  await d.getByLabel('What to print').selectOption('week');
  const [y, m, dd] = from.split('-').map(Number);
  if (new Date(y, m - 1, dd).getDay() !== 6) throw new Error('custom dates start from the Saturday: ' + from);
});
await step('the event and booking page weekday pickers follow it too (Saturday first here)', async () => {
  await page.keyboard.press('Escape');
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const d = page.getByRole('dialog', { name: 'New event' });
  await d.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('weekly');
  const days = await d.getByRole('group', { name: 'On these days' }).getByRole('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
  if (days[0] !== 'Saturday' || days[6] !== 'Friday') throw new Error(`weekly: ${days.join(',')}`);
  await d.getByRole('combobox', { name: 'Repeat', exact: true }).selectOption('monthly-mdays');
  const cols = await d.getByRole('group', { name: 'Which days of the month' }).locator('thead th[scope="col"]').evaluateAll((ths) => ths.map((t) => t.getAttribute('title')));
  if (cols[0] !== 'Saturday' || cols[1] !== 'Sunday') throw new Error(`days of the month: ${cols.join(',')}`);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const bp = page.getByRole('dialog', { name: 'Booking pages' });
  await bp.getByRole('button', { name: /New booking page/ }).click();
  const labels = (await bp.locator('.booking-weekdays label').allTextContents()).map((t) => t.trim());
  if (labels[0] !== 'Sat' || labels[6] !== 'Fri') throw new Error(`booking days: ${labels.join(',')}`);
});
await step('another browser (nothing stored in it): the week starts on Saturday there too; weekends, tasks and Kim’s calendar beside yours as chosen', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.goto(`${B}/calendar`);
  await page.getByLabel('Show weekends').uncheck();
  await page.getByLabel('Show tasks with due dates').uncheck();
  const kimId = (await api(page, 'GET', '/users')).body.find((u) => u.name === 'Kim Park').id;
  await page.getByLabel("Show a colleague's calendar").selectOption(kimId);
  await page.getByRole('button', { name: 'Hide Kim Park' }).waitFor();
  await until(async () => { const c = (await api(page, 'GET', '/auth/me')).body.user.cal_prefs; return c.weekends === false && c.showTasks === false && c.others?.some((o) => o.id === kimId); });
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(B);
  await p2.getByLabel(/Email/).first().fill('olivia@acme.com');
  await p2.getByLabel(/Password/).first().fill('password123');
  await p2.getByRole('button', { name: /Sign in/ }).click();
  await p2.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await p2.goto(`${B}/calendar`);
  if ((await p2.getByLabel('Week starts on').inputValue()) !== '6') throw new Error(`week starts on ${await p2.getByLabel('Week starts on').inputValue()}`);
  if (await p2.getByLabel('Show weekends').isChecked()) throw new Error('weekends shown in the other browser');
  if (await p2.getByLabel('Show tasks with due dates').isChecked()) throw new Error('tasks shown in the other browser');
  await p2.getByRole('button', { name: 'Hide Kim Park' }).waitFor({ timeout: 5000 }); // Kim's calendar is beside yours there too
  await ctx2.close();
});
await step('a browser that had chosen Monday before: kept for the account the first time', async () => {
  // As before this was kept with accounts: nothing chosen on the server, Monday in this browser.
  await api(page, 'PUT', '/users/me/calendar-prefs', { reset: true });
  await page.evaluate(() => localStorage.setItem('nw.calWeekStart', '1'));
  await page.reload();
  await page.getByLabel('Week starts on').waitFor();
  if ((await page.getByLabel('Week starts on').inputValue()) !== '1') throw new Error('this browser’s Monday isn’t used');
  await until(async () => (await api(page, 'GET', '/auth/me')).body.user.cal_prefs.weekStart === 1);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
