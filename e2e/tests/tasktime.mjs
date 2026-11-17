import { chromium } from 'playwright';
import fs from 'node:fs';
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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
await step('setup: a colleague', async () => {
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
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let list, design;
const details = (p) => p.getByRole('complementary', { name: 'Task details' });
const timeBox = (p) => details(p).getByRole('region', { name: 'Time' });
const row = (p, t) => p.getByRole('list', { name: 'Tasks', exact: true }).locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
await step('a timer on a task: started, shown on the list for everyone, stopped', async () => {
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Client work' })).body.id;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/tasks/lists/${list}/members`, { user_ids: [kimId] });
  design = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Design' })).body.id;
  await page.goto(`${B}/tasks/${list}`);
  await kim.goto(`${B}/tasks/${list}`);
  await row(page, 'Design').locator('.task-main').click();
  await timeBox(page).getByRole('button', { name: '▶ Start timer' }).click();
  await timeBox(page).getByRole('button', { name: /■ Stop timer/ }).waitFor();
  await row(page, 'Design').locator('.pill.timing', { hasText: 'Olivia' }).waitFor();
  await row(kim, 'Design').locator('.pill.timing', { hasText: 'Olivia' }).waitFor(); // live for the colleague
  await timeBox(page).getByRole('button', { name: /■ Stop timer/ }).click();
  await page.getByText('Timer stopped').waitFor();
  await until(async () => !(await row(kim, 'Design').locator('.pill.timing').count()));
});
await step('time added by hand, totals per person; only your own entries can be removed', async () => {
  await row(kim, 'Design').locator('.task-main').click();
  await timeBox(kim).getByRole('button', { name: 'Add time' }).click();
  await timeBox(kim).getByLabel('How long').fill('1h 30m');
  await timeBox(kim).getByLabel('What for (optional)').fill('Workshop');
  await timeBox(kim).getByRole('button', { name: 'Add', exact: true }).click();
  await timeBox(kim).getByText(/Kim Park · .* · 1 h 30 min · Workshop/).waitFor();
  await row(page, 'Design').locator('.task-time', { hasText: '1 h 30 min' }).waitFor();
  await timeBox(page).getByText(/1 h 30 min in all/).waitFor();
  await timeBox(kim).getByRole('button', { name: 'Add time' }).click();
  await timeBox(kim).getByLabel('How long').fill('lots');
  await timeBox(kim).getByRole('button', { name: 'Add', exact: true }).click();
  await kim.getByText(/Enter how long/).waitFor();
  await timeBox(kim).getByRole('button', { name: 'Cancel' }).click();
  if (await timeBox(page).getByRole('button', { name: /^Remove 1 h 30 min/ }).count()) throw new Error('could remove someone else’s');
  await timeBox(kim).getByRole('button', { name: /^Remove 1 h 30 min/ }).click();
  await until(async () => !(await timeBox(page).getByText(/1 h 30 min/).count()));
  await api(kim, 'POST', `/tasks/tasks/${design}/time`, { duration: '45m' });
});
await step('the time report: who spent how long on what, and a CSV download', async () => {
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Time report…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Time on “Client work”' });
  const table = dlg.getByRole('table', { name: 'Time report' });
  await table.getByRole('row').filter({ hasText: 'Kim Park' }).filter({ hasText: '45 min' }).waitFor();
  await table.getByRole('row').filter({ hasText: 'Olivia Owner' }).filter({ hasText: 'Design' }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('link', { name: 'Download CSV' }).click()]);
  const csv = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!/Person,Task,Minutes,Hours/.test(csv) || !/Kim Park,Design,45,0\.75/.test(csv)) throw new Error(csv);
});
await step('Focus (25 minutes): a timer that ends by itself, shown with the minutes left; stopped early it counts what ran', async () => {
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click(); // the report from the step before
  if (!(await timeBox(page).count())) await row(page, 'Design').locator('.task-main').click(); // (its details may still be open)
  await timeBox(page).getByRole('button', { name: '◎ Focus' }).click();
  await page.getByRole('menuitem', { name: '25 minutes' }).click();
  await page.getByText('Focus for 25 minutes: the timer stops by itself').waitFor();
  await timeBox(page).getByRole('button', { name: /■ Stop focus \((25|24) min left\)/ }).waitFor();
  const t = (await api(page, 'GET', '/tasks/timer')).body;
  if (t.until - t.since !== 25 * 60e3) throw new Error(JSON.stringify(t));
  await row(kim, 'Design').locator('.pill.timing', { hasText: 'Olivia' }).waitFor(); // as any timer, for the others
  await timeBox(page).getByRole('button', { name: /■ Stop focus/ }).click();
  await page.getByText('Timer stopped').waitFor();
  if ((await api(page, 'GET', '/tasks/timer')).body) throw new Error('still running');
});
await step('Focus for 50 minutes: the length chosen is the one kept', async () => {
  await timeBox(page).getByRole('button', { name: '◎ Focus' }).click();
  await page.getByRole('menuitem', { name: '50 minutes' }).click();
  await timeBox(page).getByRole('button', { name: /■ Stop focus \((50|49) min left\)/ }).waitFor();
  const t = (await api(page, 'GET', '/tasks/timer')).body;
  if (t.until - t.since !== 50 * 60e3) throw new Error(JSON.stringify(t));
  await timeBox(page).getByRole('button', { name: /■ Stop focus/ }).click();
  await page.getByText('Timer stopped').last().waitFor();
});
await step('the running timer shows in the top bar in any app; stopped from there', async () => {
  await timeBox(page).getByRole('button', { name: '◎ Focus' }).click();
  await page.getByRole('menuitem', { name: '15 minutes' }).click();
  await timeBox(page).getByRole('button', { name: /■ Stop focus/ }).waitFor();
  await page.goto(`${B}/drive`);
  const chip = page.getByRole('status', { name: /^Design: (15|14) min left$/ });
  await chip.waitFor({ timeout: 10000 });
  await chip.getByRole('button', { name: 'Stop the timer' }).click();
  await chip.waitFor({ state: 'detached' });
  if ((await api(page, 'GET', '/tasks/timer')).body) throw new Error('still running');
  // A plain timer: the time so far; the name opens the task.
  await api(page, 'POST', `/tasks/tasks/${design}/timer`);
  await page.reload();
  const plain = page.getByRole('status', { name: /^Design: \d+ min$/ });
  await plain.waitFor({ timeout: 10000 });
  await plain.getByRole('button', { name: /Design/ }).click();
  await page.waitForURL(/\/tasks\/.*task=/);
  await api(page, 'POST', '/tasks/timer/stop');
});
await step('Home: Time this week, with the tasks most time went on', async () => {
  await api(page, 'POST', `/tasks/tasks/${design}/time`, { duration: '30m' }); // (the timers above ran for seconds)
  await page.goto(`${B}/home`);
  const card = page.locator('section[aria-label="Time this week"]');
  await card.waitFor({ timeout: 15000 });
  await card.getByText(/on tasks in the last 7 days/).waitFor();
  await card.getByRole('link', { name: 'Design' }).click();
  await page.waitForURL(/\/tasks\/.*task=/);
});
await step('T starts your timer on the task in view, and stops it', async () => {
  await page.goto(`${B}/tasks`);
  await row(page, 'Design').waitFor();
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('j');
  await page.keyboard.press('t');
  await page.getByText('Timer started on “Design”').waitFor();
  await page.getByRole('status', { name: /^Design: \d+ min$/ }).waitFor(); // in the top bar
  if ((await api(page, 'GET', '/tasks/timer')).body?.task_id !== design) throw new Error('not on Design');
  await page.keyboard.press('t');
  await page.getByText('Timer stopped on “Design”').waitFor();
  await until(async () => !(await api(page, 'GET', '/tasks/timer')).body);
});
await step('T works in My Day too', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const d = new Date(); const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await api(page, 'POST', `/tasks/tasks/${design}/myday`, { today: local || today });
  await page.goto(`${B}/tasks`);
  await page.getByRole('link', { name: /My Day/ }).first().click().catch(() => page.getByText('My Day').first().click());
  await row(page, 'Design').waitFor({ timeout: 10000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('j');
  await page.keyboard.press('t');
  await page.getByText('Timer started on “Design”').waitFor();
  await page.keyboard.press('t');
  await page.getByText('Timer stopped on “Design”').waitFor();
});
await step('while Olivia is in a focus session, colleagues see “Focusing” by her name', async () => {
  // Kim has the Directory open already: it changes as Olivia starts and stops, without reloading.
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('tab', { name: 'Directory' }).click();
  const olivia = kim.locator('tr', { hasText: 'Olivia Owner' });
  await olivia.waitFor();
  await api(page, 'POST', `/tasks/tasks/${design}/timer`, { minutes: 25 });
  await olivia.getByText(/Focusing/).waitFor({ timeout: 10000 });
  await api(page, 'POST', '/tasks/timer/stop');
  await olivia.getByText(/Focusing/).waitFor({ state: 'detached', timeout: 10000 });
});
await step('Settings: notifications can wait during focus sessions', async () => {
  await page.goto(`${B}/settings`);
  const box = page.getByLabel(/Pause notifications during focus sessions on tasks/);
  await box.check();
  await page.getByText('Notifications wait during focus sessions on tasks').waitFor();
  await api(page, 'POST', `/tasks/tasks/${design}/timer`, { minutes: 15 });
  const p = (await api(page, 'GET', '/users/me/pause')).body;
  if (!p.paused_until || !p.focus) throw new Error(JSON.stringify(p));
  await page.reload();
  await page.getByRole('button', { name: /Notifications paused until|Resume/ }).first().waitFor({ timeout: 10000 }).catch(async () => {
    await page.locator('.paused-mark').waitFor({ timeout: 5000 }); // 🔕 in the top bar
  });
  await api(page, 'POST', '/tasks/timer/stop');
  await box.uncheck();
});
await step('Calendar → Time insights shows the week’s time on tasks beside meetings', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Time insights/ }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Time insights' });
  await dlg.getByText('⏱ On tasks').waitFor({ timeout: 10000 });
  await dlg.getByRole('list', { name: 'Tasks you tracked time on' }).getByRole('link', { name: 'Design' }).waitFor();
  const today = new Date().toLocaleDateString([], { weekday: 'short' });
  await dlg.getByRole('list', { name: 'Each day' }).getByLabel(new RegExp(`^${today}: .* on tasks$`)).waitFor({ timeout: 5000 });
  if (!(await dlg.locator('.insight-bar .seg.tasks').count())) throw new Error('no task segment in the day bars');
  await page.screenshot({ path: `${SP}/shots/insights-tasks.png` });
});
await step('Time insights → the previous week shows the time logged then, on its day', async () => {
  const d = new Date(); d.setDate(d.getDate() - 7);
  const day = d.toISOString().slice(0, 10);
  const t = (await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Last week’s report' })).body;
  await api(page, 'POST', `/tasks/tasks/${t.id}/time`, { duration: '1h 30m', day });
  const dlg = page.getByRole('dialog', { name: 'Time insights' });
  await dlg.getByRole('button', { name: 'Previous week' }).click();
  await dlg.getByRole('list', { name: 'Tasks you tracked time on' }).getByRole('link', { name: 'Last week’s report' }).waitFor({ timeout: 10000 });
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString([], { weekday: 'short' });
  await dlg.getByRole('list', { name: 'Each day' }).getByLabel(`${label}: 0 h in events, 1.5 h on tasks`).waitFor({ timeout: 5000 });
  await dlg.getByRole('button', { name: 'Next week' }).click();
  await dlg.getByRole('list', { name: 'Tasks you tracked time on' }).getByRole('link', { name: 'Design' }).waitFor({ timeout: 10000 });
});
await step('away from a running timer: coming back asks whether to count the time away', async () => {
  await page.goto(`${B}/drive`);
  await page.evaluate(() => localStorage.setItem('nw-away-seconds', '3'));
  await api(page, 'POST', `/tasks/tasks/${design}/timer`);
  await page.reload();
  await page.getByRole('status', { name: /^Design: \d+ min$/ }).waitFor({ timeout: 10000 });
  const before = (await api(page, 'GET', '/tasks/timer')).body;
  await page.mouse.move(200, 300);
  await page.waitForTimeout(6500); // away (nothing typed or moved); the test threshold is 3 s
  await page.mouse.move(260, 340);
  const dlg = page.getByRole('dialog', { name: 'You were away' });
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByText(/while the timer ran on Design/).waitFor();
  await page.screenshot({ path: `${SP}/shots/timer-away.png` });
  await dlg.getByRole('button', { name: 'Leave it out and carry on' }).click();
  await page.getByText('Time away left out; the timer carries on').last().waitFor();
  const after = (await api(page, 'GET', '/tasks/timer')).body;
  if (!after || after.task_id !== design || after.since <= before.since) throw new Error(JSON.stringify({ before, after }));
  // Away again: "Keep the time" changes nothing; then "Leave it out and stop" stops it.
  await page.waitForTimeout(6500);
  await page.mouse.move(300, 300);
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByRole('button', { name: 'Keep the time' }).click();
  await dlg.waitFor({ state: 'detached' });
  if ((await api(page, 'GET', '/tasks/timer')).body?.since !== after.since) throw new Error('kept time changed the timer');
  await page.waitForTimeout(6500);
  await page.keyboard.press('Shift');
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByRole('button', { name: 'Leave it out and stop' }).click();
  await page.getByRole('status', { name: /^Design:/ }).waitFor({ state: 'detached', timeout: 5000 });
  if ((await api(page, 'GET', '/tasks/timer')).body) throw new Error('still running');
  await page.evaluate(() => localStorage.removeItem('nw-away-seconds'));
});
await step('Tasks → My timesheet: the week day by day; a day’s cell adds time; other weeks; CSV', async () => {
  await page.goto(`${B}/tasks`);
  await page.getByRole('button', { name: 'My timesheet' }).click();
  const dlg = page.getByRole('dialog', { name: 'My timesheet' });
  const table = dlg.getByRole('table', { name: 'Timesheet' });
  await table.getByRole('rowheader', { name: 'Design' }).waitFor({ timeout: 10000 });
  const total = async () => (await table.getByLabel(/^Week total:/).getAttribute('aria-label'));
  const before = await total();
  const today = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  await table.getByRole('button', { name: new RegExp(`^Design, ${today}: .*Add time$`) }).click();
  const form = dlg.getByRole('form', { name: 'Add time' });
  await form.getByLabel('How long').fill('45m');
  await form.getByRole('button', { name: 'Add' }).click();
  await page.getByText('Added to “Design”').last().waitFor();
  await page.waitForFunction(([b]) => { const el = document.querySelector('[aria-label^="Week total:"]'); return el && el.getAttribute('aria-label') !== b; }, [before], { timeout: 10000 });
  await page.screenshot({ path: `${SP}/shots/timesheet.png` });
  // A future day can't take time.
  const d = new Date(); d.setDate(d.getDate() + 1);
  if (d.getDay() !== 1) { // tomorrow still in this week
    const tomorrow = d.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
    if (!(await table.getByRole('button', { name: new RegExp(`^Design, ${tomorrow}:`) }).isDisabled())) throw new Error('tomorrow is open');
  }
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Download CSV' }).click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  if (!/^Task,\d{4}-\d\d-\d\d,/.test(csv) || !/\nDesign,/.test(csv) || !/\nTotal,/.test(csv)) throw new Error(csv.slice(0, 300));
  await dlg.getByRole('button', { name: 'Previous week' }).click();
  await table.getByRole('rowheader', { name: 'Last week’s report' }).waitFor({ timeout: 10000 });
  await table.getByRole('row', { name: /Last week’s report/ }).getByText('1:30').first().waitFor();
  await table.getByRole('rowheader', { name: 'Last week’s report' }).getByRole('button').click();
  await page.waitForURL(/task=/);
});
await step('the time report at an hourly rate: amounts per line, a total, and in the CSV; removed again', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await page.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Time report…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Time on “Client work”' });
  await dlg.getByText('No hourly rate').waitFor({ timeout: 10000 });
  await dlg.getByRole('button', { name: 'Set an hourly rate' }).click();
  const form = dlg.getByRole('form', { name: 'Hourly rate' });
  await form.getByLabel('Hourly rate').fill('80');
  await form.getByLabel('Currency').selectOption('EUR');
  await form.getByRole('button', { name: 'Save rate' }).click();
  await dlg.getByText(/^Billed at €80\.00 an hour$/).waitFor({ timeout: 10000 });
  const table = dlg.getByRole('table', { name: 'Time report' });
  await table.getByRole('columnheader', { name: 'Amount' }).waitFor();
  // Kim's 45 minutes on Design: €60.00.
  await table.getByRole('row').filter({ hasText: 'Kim Park' }).filter({ hasText: '€60.00' }).first().waitFor();
  await table.getByLabel(/^Total amount: €[\d,]+\.\d\d$/).waitFor();
  await page.screenshot({ path: `${SP}/shots/report-rate.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('link', { name: 'Download CSV' }).click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  if (!/Person,Task,Minutes,Hours,"Amount \(EUR, 80\.00\/h\)"/.test(csv) || !/Kim Park,Design,45,0\.75,60\.00/.test(csv)) throw new Error(csv);
  // The colleague sees the amounts but can't change the rate.
  const r = (await api(kim, 'PUT', `/tasks/lists/${list}/rate`, { rate: 1, currency: 'EUR' })).status;
  if (r !== 400) throw new Error(`colleague set the rate: ${r}`);
  await dlg.getByRole('button', { name: 'Change rate' }).click();
  await form.getByRole('button', { name: 'Remove rate' }).click();
  await dlg.getByText('No hourly rate').waitFor();
  if (await table.getByRole('columnheader', { name: 'Amount' }).count()) throw new Error('amounts still shown');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
