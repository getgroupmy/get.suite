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
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
const wrap = () => page.locator('.compose-editor .tiptap .img-wrap');
const width = async () => Number((await wrap().getAttribute('data-width')) || 100);
// Shown share of the message width, measured on screen.
const shown = () => page.evaluate(() => {
  const w = document.querySelector('.compose-editor .tiptap .img-wrap');
  const ed = document.querySelector('.compose-editor .tiptap');
  const cs = getComputedStyle(ed);
  return Math.round((w.getBoundingClientRect().width / (ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))) * 100);
});
const dragTo = async (pct) => {
  const h = await page.locator('.img-handle').boundingBox();
  const ed = await page.evaluate(() => {
    const e = document.querySelector('.compose-editor .tiptap');
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { left: r.left + parseFloat(cs.paddingLeft), width: e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
  });
  const startX = h.x + h.width / 2, y = h.y + h.height / 2;
  const handleOffset = startX - (await wrap().boundingBox()).x - (await wrap().boundingBox()).width;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(ed.left + (ed.width * pct) / 100 + handleOffset - 20, y, { steps: 5 });
  await page.locator('.img-size-label').waitFor(); // live label while dragging
  await page.mouse.move(ed.left + (ed.width * pct) / 100 + handleOffset, y, { steps: 5 });
  await page.mouse.up();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});



const HOUR = 48;
await step('events-for-today', async () => {
  // Created in the browser's own time zone: today 9:00–10:30 and 10:00–11:00 (overlapping), an all-day
  // event today, and tomorrow 14:00–15:00.
  const r = await page.evaluate(async () => {
    const at = (dayOffset, h, m = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + dayOffset); d.setHours(h, m); return d.getTime(); };
    const mk = (body) => fetch('/api/events', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.status);
    return Promise.all([
      mk({ title: 'Standup', start: at(0, 9), end: at(0, 10, 30) }),
      mk({ title: 'Review', start: at(0, 10), end: at(0, 11), color: '#0b8043' }),
      mk({ title: 'Offsite', start: at(0, 0), end: at(1, 0) - 1, all_day: true }),
      mk({ title: 'Lunch', start: at(1, 14), end: at(1, 15) }),
    ]);
  });
  if (r.some((s) => s !== 201)) throw new Error(JSON.stringify(r));
});

const view = (name) => page.getByRole('radio', { name });
await step('week-view-lays-out-events', async () => {
  await page.goto(B + '/calendar');
  await view('Week').click();
  await page.locator('.timegrid').waitFor();
  if ((await page.locator('.tg-col').count()) !== 7) throw new Error('7 days expected');
  const standup = page.locator('.tg-event', { hasText: 'Standup' });
  const review = page.locator('.tg-event', { hasText: 'Review' });
  await standup.waitFor();
  const [a, b, col] = [await standup.boundingBox(), await review.boundingBox(), await standup.locator('xpath=..').boundingBox()];
  if (Math.abs((a.y - col.y) - 9 * HOUR) > 2) throw new Error('Standup not at 9:00: ' + (a.y - col.y));
  if (Math.abs(a.height - 1.5 * HOUR) > 4) throw new Error('Standup height ' + a.height);
  if (Math.abs((b.y - col.y) - 10 * HOUR) > 2) throw new Error('Review not at 10:00');
  if (!(a.width < col.width * 0.6 && b.width < col.width * 0.6 && Math.abs(a.x - b.x) > 10)) throw new Error('overlapping events not side by side');
  await page.locator('.tg-allday .chip', { hasText: 'Offsite' }).waitFor();
  if (await page.locator('.tg-event', { hasText: 'Offsite' }).count()) throw new Error('all-day event in the hour grid');
  if (!(await page.locator('.tg-col.today .tg-now').count())) throw new Error('no current-time line');
  await page.screenshot({ path: `${SP}/shots/cal-week.png` });
});

await step('click-a-slot-to-create', async () => {
  const col = page.locator('.tg-col.today');
  await page.locator('.tg-scroll').evaluate((el) => { el.scrollTop = 13 * 48; });
  const box = await col.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 15 * HOUR + 10); // within 15:00–15:30
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.waitFor();
  if ((await dlg.getByLabel('Start time').inputValue()) !== '15:00') throw new Error('start ' + await dlg.getByLabel('Start time').inputValue());
  if ((await dlg.getByLabel('End time').inputValue()) !== '16:00') throw new Error('end');
  await dlg.getByLabel('Title').fill('Planning');
  await dlg.getByRole('button', { name: 'Save' }).click();
  const p = page.locator('.tg-col.today .tg-event', { hasText: 'Planning' });
  await p.waitFor();
  const [pb, cb] = [await p.boundingBox(), await col.boundingBox()];
  if (Math.abs((pb.y - cb.y) - 15 * HOUR) > 2) throw new Error('Planning not at 15:00');
});

await step('day-view-and-moving-between-days', async () => {
  await page.locator('.tg-head button.tg-day').filter({ has: page.locator('.tg-num.today') }).click();
  if ((await view('Day').getAttribute('aria-checked')) !== 'true') throw new Error('day view not selected');
  if ((await page.locator('.tg-col').count()) !== 1) throw new Error('one column expected');
  const todayTitle = await page.locator('.cal-head h1').innerText();
  await page.getByRole('button', { name: 'Next day' }).click();
  await page.locator('.tg-event', { hasText: 'Lunch' }).waitFor();
  // The upcoming list doesn't depend on the day shown.
  await page.locator('.subnav .upcoming', { hasText: 'Lunch' }).waitFor(); // tomorrow: listed whatever the time now
  await page.locator('.subnav .upcoming', { hasText: 'Offsite' }).waitFor(); // today, all day
  if (await page.locator('.tg-event', { hasText: 'Standup' }).count()) throw new Error("yesterday's event shown");
  await page.locator('body').click({ position: { x: 5, y: 890 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction((t) => document.querySelector('.cal-head h1').innerText === t, todayTitle);
  await page.screenshot({ path: `${SP}/shots/cal-day.png` });
});

await step('view-is-remembered-and-month-opens-a-day', async () => {
  await page.reload();
  await page.locator('.timegrid').waitFor();
  if ((await view('Day').getAttribute('aria-checked')) !== 'true') throw new Error('view not remembered');
  await view('Month').click();
  await page.locator('.month').waitFor();
  await page.locator('.chip', { hasText: 'Standup' }).waitFor();
  await page.locator('.day.today .daynum').click();
  await page.locator('.tg-event', { hasText: 'Standup' }).waitFor();
  if ((await view('Day').getAttribute('aria-checked')) !== 'true') throw new Error('month date did not open the day');
});

const inWeek = (title) => page.locator('.tg-event', { hasText: title });
const nextWeek = () => page.getByRole('button', { name: 'Next week' }).click();
await step('create-a-weekly-event', async () => {
  await page.goto(B + '/calendar');
  await view('Week').click();
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Weekly 1:1');
  await dlg.getByLabel('Start time').fill('16:00');
  await dlg.getByLabel('End time').fill('16:30');
  await dlg.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  await dlg.getByText(/^Weekly on /).waitFor();
  await dlg.screenshot({ path: `${SP}/shots/cal-repeat-dialog.png` });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await inWeek('Weekly 1:1').waitFor();
  for (let i = 0; i < 3; i++) { await nextWeek(); await inWeek('Weekly 1:1').waitFor(); }
  if (!/repeats/.test(await inWeek('Weekly 1:1').getAttribute('title'))) throw new Error('not marked as repeating');
});

await step('change-only-this-occurrence', async () => {
  await page.getByRole('button', { name: 'Today' }).click();
  await nextWeek();
  await inWeek('Weekly 1:1').click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  await dlg.getByLabel('Title').fill('Moved 1:1');
  await dlg.getByLabel('Start time').fill('17:00');
  await dlg.getByLabel('End time').fill('17:30');
  await dlg.getByRole('button', { name: 'Save' }).click();
  const scope = page.getByRole('dialog', { name: 'Change repeating event' });
  await scope.getByLabel('This event').check();
  await scope.getByRole('button', { name: 'Save' }).click();
  await inWeek('Moved 1:1').waitFor();
  if (await inWeek('Weekly 1:1').count()) throw new Error('the series occurrence is still there');
  await page.getByRole('button', { name: 'Previous week' }).click();
  await inWeek('Weekly 1:1').waitFor();
  await nextWeek(); await nextWeek();
  await inWeek('Weekly 1:1').waitFor();
});

await step('delete-this-and-following', async () => {
  await nextWeek(); // three weeks from now
  await inWeek('Weekly 1:1').click();
  await page.getByRole('dialog', { name: 'Edit event' }).getByRole('button', { name: 'Delete' }).click();
  const scope = page.getByRole('dialog', { name: 'Delete repeating event' });
  await scope.getByLabel('This and following events').check();
  await scope.getByRole('button', { name: 'Delete' }).click();
  await inWeek('Weekly 1:1').waitFor({ state: 'detached' });
  await nextWeek();
  await page.waitForTimeout(300);
  if (await inWeek('Weekly 1:1').count()) throw new Error('still repeating after the end');
  await page.getByRole('button', { name: 'Previous week' }).click(); await page.getByRole('button', { name: 'Previous week' }).click();
  await inWeek('Weekly 1:1').waitFor(); // two weeks from now is kept
});

await step('change-all-events-and-count', async () => {
  await page.getByRole('button', { name: 'Today' }).click();
  await inWeek('Weekly 1:1').click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  await dlg.getByLabel('Title').fill('Team 1:1');
  await dlg.getByRole('button', { name: 'Save' }).click();
  const scope = page.getByRole('dialog', { name: 'Change repeating event' });
  await scope.getByLabel('All events').check();
  await scope.getByRole('button', { name: 'Save' }).click();
  await inWeek('Team 1:1').waitFor();
  await page.getByRole('button', { name: 'Next week' }).click(); await page.getByRole('button', { name: 'Next week' }).click();
  await inWeek('Team 1:1').waitFor();
  // A daily event that happens 3 times.
  await view('Month').click();
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByRole('button', { name: 'Create' }).click();
  const d2 = page.getByRole('dialog', { name: 'New event' });
  await d2.getByLabel('Title').fill('Training');
  await d2.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await d2.getByLabel('After').check();
  await d2.getByLabel('Number of times').fill('3');
  await d2.getByText('Daily, 3 times').waitFor();
  await d2.getByRole('button', { name: 'Save' }).click();
  await page.locator('.chip', { hasText: 'Training' }).first().waitFor();
  const n = await page.evaluate(async () => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const list = await (await fetch(`/api/events?from=${from.getTime()}&to=${from.getTime() + 30 * 864e5}`)).json();
    return list.filter((e) => e.title === 'Training').length;
  });
  if (n !== 1) throw new Error('stored once, expected 1 row, got ' + n);
  // Count in the week view (month cells show at most 3 events): this week plus next, in case it crosses.
  await view('Week').click();
  await page.getByRole('button', { name: 'Today' }).click();
  await page.waitForTimeout(300);
  let seen = await page.locator('.tg-event, .tg-allday .chip').filter({ hasText: 'Training' }).count();
  await nextWeek();
  await page.waitForTimeout(300);
  seen += await page.locator('.tg-event, .tg-allday .chip').filter({ hasText: 'Training' }).count();
  if (seen !== 3) throw new Error('expected 3 occurrences, got ' + seen);
});

await step('invite-a-colleague', async () => {
  const tom = await api(page, 'POST', '/users', { local: 'tom', domain: 'acme.com', name: 'Tom Teammate', password: 'password123' });
  if (tom.status !== 201) throw new Error(JSON.stringify(tom));
  // A brand-new mailbox takes a few seconds to go live on the mail server; wait for it, as a colleague's would already be.
  for (let i = 0; i < 30; i++) {
    if ((await api(page, 'POST', '/mail/send', { to: 'tom@acme.com', subject: 'Welcome', text: 'Hi Tom' })).status === 200) break;
    await page.waitForTimeout(700);
  }
  await page.goto(B + '/calendar');
  await view('Week').click();
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Budget review');
  await dlg.getByRole('combobox', { name: 'Guests' }).fill('tom@acme.com');
  await dlg.getByRole('combobox', { name: 'Guests' }).press('Enter');
  await dlg.getByRole('list', { name: 'Invited guests' }).getByText('Tom Teammate').waitFor();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await inWeek('Budget review').waitFor();

  // Tom, in his own browser: the invitation is there, tentative until he answers.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const t = await ctx.newPage();
  await t.goto(B);
  await t.getByLabel('Email address').fill('tom@acme.com');
  await t.getByLabel('Password').fill('password123');
  await t.getByRole('button', { name: 'Sign in' }).click();
  await t.getByRole('link', { name: 'Calendar' }).click();
  await t.getByRole('radio', { name: 'Week' }).click();
  const inv = t.locator('.tg-event', { hasText: 'Budget review' });
  await inv.waitFor();
  if (!(await inv.getAttribute('class')).includes('tentative')) throw new Error('not shown as tentative');
  await inv.click();
  const d = t.getByRole('dialog', { name: 'Budget review' });
  await d.getByText('Organizer:').waitFor();
  if (!/Olivia Owner/.test(await d.innerText())) throw new Error('organizer missing');
  await t.screenshot({ path: `${SP}/shots/invitation.png` });
  await d.getByRole('button', { name: 'Yes' }).click();
  await d.waitFor({ state: 'detached' });
  await t.waitForFunction(() => !document.querySelector('.tg-event.tentative'));
  // The invitation also arrived by email.
  let mail = null;
  for (let i = 0; i < 30 && !mail; i++) {
    const r = await api(t, 'GET', '/mail/messages?folder=INBOX');
    mail = (r.body?.messages || []).find((m) => m.subject === 'Invitation: Budget review');
    if (!mail) await t.waitForTimeout(700);
  }
  if (!mail) throw new Error('no invitation email');
  await ctx.close();

  // Olivia's calendar updates live: Tom said yes.
  await inWeek('Budget review').click();
  const ed = page.getByRole('dialog', { name: 'Edit event' });
  await ed.getByText('1 guest: 1 yes').waitFor();
  await page.keyboard.press('Escape');
});

await step('phone-week-view', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await view('Week').click();
  await page.locator('.timegrid').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error('page scrolls sideways on a phone');
  await page.mouse.move(380, 830);
  await page.waitForTimeout(600); // let the side navigation finish sliding away after the resize
  await page.screenshot({ path: `${SP}/shots/cal-phone.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
