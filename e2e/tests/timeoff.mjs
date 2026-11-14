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
// Next Monday to Wednesday.
const mon = new Date(); mon.setDate(mon.getDate() + ((8 - mon.getDay()) % 7 || 7));
const wed = new Date(mon); wed.setDate(mon.getDate() + 2);
await step('Kim (reporting to Olivia) asks for three days off', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const r = await api(page, 'PATCH', `/users/${dir.find((u) => u.username === 'kim@acme.com').id}`, { manager_id: dir.find((u) => u.username === 'olivia@acme.com').id });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('button', { name: /Time off/ }).click();
  const dlg = kim.getByRole('dialog', { name: 'Time off' });
  await dlg.getByLabel('First day').fill(iso(mon));
  await dlg.getByLabel('Last day').fill(iso(wed));
  await dlg.getByLabel('Note (optional)').fill('Moving house');
  await dlg.getByRole('button', { name: 'Ask', exact: true }).click();
  await kim.getByText('Asked for time off').waitFor();
  await dlg.getByRole('region', { name: 'Your time off' }).getByText('Waiting for an answer').waitFor();
  await dlg.getByText('(3 working days)').waitFor();
});
await step('Olivia sees it waiting (badge, bell) and approves with an answer', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Time off.*1 waiting for your answer/ }).waitFor();
  await page.screenshot({ path: `${SP}/shots/timeoff-badge.png` });
  await page.getByRole('button', { name: /Time off/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  const waiting = dlg.getByRole('region', { name: 'Waiting for your answer' });
  await waiting.getByText('Moving house').waitFor();
  await waiting.getByLabel('Answer to Kim Park (optional)').fill('Good luck with the move');
  await dlg.screenshot({ path: `${SP}/shots/timeoff-approve.png` });
  await waiting.getByRole('button', { name: "Approve Kim Park's time off" }).click();
  await page.getByText("Approved Kim Park's time off").waitFor();
  await until(async () => (await waiting.count()) === 0);
});
await step('Kim is told and the days are on her calendar as out of office', async () => {
  const bell = (await api(kim, 'GET', '/notifications')).body.items;
  if (!bell.some((n) => n.title === 'Olivia Owner approved your time off' && /Good luck/.test(n.body))) throw new Error(JSON.stringify(bell.map((n) => n.title)));
  await kim.reload();
  await kim.getByRole('button', { name: /Time off/ }).click();
  const dlg = kim.getByRole('dialog', { name: 'Time off' });
  await dlg.getByText(/Approved by Olivia Owner: “Good luck with the move”/).waitFor();
  await dlg.getByRole('button', { name: 'Done' }).click();
  const evs = (await api(kim, 'GET', `/events?from=${mon.getTime() - 864e5}&to=${wed.getTime() + 2 * 864e5}`)).body;
  const ev = evs.find((e) => e.kind === 'ooo');
  if (!ev || ev.title !== 'Vacation' || !ev.all_day || ev.start !== new Date(mon.getFullYear(), mon.getMonth(), mon.getDate()).getTime()) throw new Error(JSON.stringify(ev));
});
await step('Kim cancels it: the event goes and Olivia is told', async () => {
  await kim.getByRole('button', { name: /Time off/ }).click();
  const dlg = kim.getByRole('dialog', { name: 'Time off' });
  await dlg.getByRole('button', { name: /^Cancel time off/ }).click();
  await kim.getByText('Time off cancelled').waitFor();
  await dlg.getByText('Cancelled').waitFor();
  const evs = (await api(kim, 'GET', `/events?from=${mon.getTime() - 864e5}&to=${wed.getTime() + 2 * 864e5}`)).body;
  if (evs.some((e) => e.kind === 'ooo')) throw new Error('event still there');
  const bell = (await api(page, 'GET', '/notifications')).body.items;
  if (!bell.some((n) => n.title === 'Kim Park cancelled time off')) throw new Error('not told');
});
await step('Olivia (admin) gives everyone 20 vacation days in Team; Kim sees what she has left', async () => {
  await page.reload();
  await page.getByRole('button', { name: /Time off/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  await dlg.getByRole('tab', { name: 'Team' }).click();
  await dlg.getByLabel('Vacation days a year (company)').fill('20');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('20 vacation days a year for everyone').waitFor();
  await dlg.getByLabel('Vacation days a year for Kim Park').fill('3');
  await dlg.getByLabel('Vacation days a year for Kim Park').press('Enter');
  await page.getByText('Kim Park: 3 days a year').waitFor();
  await dlg.getByRole('row', { name: /Kim Park/ }).getByText('3 left').waitFor();
  await dlg.screenshot({ path: `${SP}/shots/timeoff-team.png` });
  await dlg.getByRole('button', { name: 'Done' }).click();
  await kim.reload();
  await kim.getByRole('button', { name: /Time off/ }).click();
  const k = kim.getByRole('dialog', { name: 'Time off' });
  const year = mon.getFullYear();
  await k.getByText(new RegExp(`You have 3 of 3 vacation days left in ${year}`)).waitFor();
  // Four working days: more than she has.
  const thu = new Date(mon); thu.setDate(mon.getDate() + 3);
  await k.getByLabel('First day').fill(iso(mon));
  await k.getByLabel('Last day').fill(iso(thu));
  await k.getByRole('button', { name: 'Ask', exact: true }).click();
  if (mon.getFullYear() === thu.getFullYear()) await kim.getByText(`That's 4 vacation days in ${year}; you have 3 left`).waitFor();
});
await step('a company holiday: added in Team, on everyone\'s calendar, not a working day in time off', async () => {
  // A Tuesday in two weeks.
  const tue = new Date(mon); tue.setDate(mon.getDate() + 8);
  await page.reload();
  await page.getByRole('button', { name: /Time off/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  await dlg.getByRole('tab', { name: 'Team' }).click();
  const hol = dlg.getByRole('region', { name: 'Company holidays' });
  await hol.getByLabel('Holiday').fill(iso(tue));
  await hol.getByLabel('Name').fill('Founders Day');
  await hol.getByRole('button', { name: 'Add holiday' }).click();
  await page.getByText('Founders Day added').waitFor();
  await hol.getByText(/Founders Day/).waitFor();
  await dlg.getByRole('button', { name: 'Done' }).click();
  // On Kim's calendar (week of the holiday).
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('radio', { name: 'Week', exact: true }).click();
  await kim.getByRole('button', { name: 'Next week' }).click();
  await kim.getByRole('button', { name: 'Next week' }).click();
  await kim.getByText('🏳 Founders Day').waitFor();
  await kim.screenshot({ path: `${SP}/shots/holiday-week.png` });
  // A week of personal time off around it is 4 working days.
  const fri = new Date(tue); fri.setDate(tue.getDate() + 3);
  const prevMon = new Date(tue); prevMon.setDate(tue.getDate() - 1);
  const r = await api(kim, 'POST', '/time-off', { start_date: iso(prevMon), end_date: iso(fri), kind: 'personal', tz: 'UTC' });
  if (r.body.days !== 4) throw new Error(JSON.stringify(r.body));
});
await step('Home: who is out today, back when, and the next company holiday', async () => {
  const today = new Date();
  if ([0, 6].includes(today.getDay())) return; // nobody takes a weekend off
  const ask = await api(kim, 'POST', '/time-off', { start_date: iso(today), end_date: iso(today), kind: 'sick', tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (ask.status !== 201) throw new Error(JSON.stringify(ask.body));
  await page.goto(`${B}/home`);
  const card = page.getByRole('region', { name: "Who's out" });
  await card.getByText(/\d time-off requests? waiting for your answer/).waitFor();
  await api(page, 'POST', `/time-off/${ask.body.id}/decide`, { approve: true });
  await page.reload();
  await card.getByText('Kim Park').waitFor();
  await card.getByText(/^back (tomorrow|\w{3} \d+ \w{3}|\w{3}, \w{3} \d+)/).waitFor();
  await card.getByText(/Founders Day/).waitFor();
  await card.screenshot({ path: `${SP}/shots/home-out.png` });
});
await step('half a day: the afternoon of one day, shown as such and counted as half', async () => {
  const fri = new Date(mon); fri.setDate(mon.getDate() + 18); // a Friday, clear of the rest
  await kim.goto(`${B}/calendar`);
  await kim.getByRole('button', { name: /Time off/ }).click();
  const k = kim.getByRole('dialog', { name: 'Time off' });
  await k.getByLabel('First day').fill(iso(fri));
  await k.getByLabel('Last day').fill(iso(fri));
  await k.getByLabel('Part of the day').selectOption('pm');
  await k.getByLabel('Note (optional)').fill('School play');
  await k.getByRole('button', { name: 'Ask', exact: true }).click();
  await kim.getByText('Asked for time off').waitFor();
  await k.getByText(/\(afternoon\) \(half a working day\)/).waitFor();
  // Two days apart: no choice of half a day.
  const sat = new Date(fri); sat.setDate(fri.getDate() + 3);
  await k.getByLabel('Last day').fill(iso(sat));
  if (await k.getByLabel('Part of the day').count()) throw new Error('half a day offered for several days');
});
await step('admins download the year\'s time off for payroll', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Time off/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  await dlg.getByRole('tab', { name: 'Team' }).click();
  const year = new Date().getFullYear();
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('link', { name: `Download ${year}'s time off (.csv)` }).click()]);
  if (dl.suggestedFilename() !== `time-off-${year}.csv`) throw new Error(dl.suggestedFilename());
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!text.includes('Name,Email,Kind,First day')) throw new Error(text.slice(0, 200));
  if (new Date().getDay() % 6 && !text.includes('Kim Park,kim@acme.com,Sick leave')) throw new Error(text);
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
