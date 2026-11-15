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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
const fs = await import('node:fs');
const takeout = async () => {
  const z = new JSZip();
  const ev = (uid, title) => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:20261203T090000Z\r\nDTEND:20261203T100000Z\r\nEND:VEVENT\r\n`;
  z.file('Takeout/archive_browser.html', '<html></html>');
  z.file('Takeout/Calendar/me@gmail.com.ics', `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ev('mv1@google.com', 'Quarterly review')}END:VCALENDAR\r\n`);
  z.file('Takeout/Calendar/Running club.ics', `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ev('mv2@google.com', 'Long run')}END:VCALENDAR\r\n`);
  z.file('Takeout/Contacts/All Contacts/All Contacts.vcf', 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Grace Hopper\r\nEMAIL:grace@example.com\r\nEND:VCARD\r\n');
  z.file('Takeout/Drive/Plans/Roadmap.txt', 'Ship it');
  z.file('Takeout/Keep/Packing.json', JSON.stringify({ title: 'Packing', textContent: 'Passport', isPinned: false, isArchived: false, isTrashed: false, color: 'DEFAULT', userEditedTimestampUsec: 1700000000000000, createdTimestampUsec: 1700000000000000 }));
  z.file('Takeout/Tasks/Tasks.json', JSON.stringify({ kind: 'tasks#taskLists', items: [{ kind: 'tasks#tasks', title: 'Garden', items: [{ kind: 'tasks#task', id: 't1', title: 'Mow the lawn', status: 'needsAction' }] }] }));
  z.file('Takeout/YouTube and YouTube Music/history.html', '<html></html>');
  const file = `${SP}/takeout-test.zip`;
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
  return file;
};
await step('Settings has steps for Google, Microsoft and Zoho', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Move here from another service' });
  await card.getByRole('list', { name: 'Steps for Google Workspace or Gmail' }).getByText('takeout.google.com').waitFor();
  await card.getByRole('button', { name: 'Microsoft 365 or Outlook.com' }).click();
  await card.getByRole('list', { name: 'Steps for Microsoft 365 or Outlook.com' }).getByText('Export contacts').waitFor();
  await card.getByRole('button', { name: 'Zoho Workplace or Zoho Mail' }).click();
  await card.getByRole('list', { name: 'Steps for Zoho Workplace or Zoho Mail' }).getByText('WorkDrive').waitFor();
  await card.getByRole('button', { name: 'Google Workspace or Gmail' }).click();
  if ((await card.getByRole('button', { name: 'Google Workspace or Gmail' }).getAttribute('aria-pressed')) !== 'true') throw new Error('not shown as chosen');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/movehere.png` });
  await axe(page, 'move here');
});
await step('a Takeout .zip brings calendars, contacts, Drive, Keep and Tasks, and says what was left out', async () => {
  const card = page.getByRole('region', { name: 'Move here from another service' });
  await card.getByLabel('Your Google Workspace or Gmail export (.zip)').setInputFiles(await takeout());
  await page.getByText(/From Google: brought in 1 file into “From Google \d{4}-\d\d-\d\d” in Drive, 2 events, 1 contact, 1 task list \(1 task\), 1 note/).waitFor({ timeout: 30000 });
  await page.getByText('Left out (not part of Workspace): YouTube and YouTube Music').waitFor();
  const events = (await api(page, 'GET', `/events?from=${Date.UTC(2026, 11, 1)}&to=${Date.UTC(2026, 11, 31)}`)).body;
  const titles = (Array.isArray(events) ? events : events.events || []).map((e) => e.title).sort();
  if (titles.join() !== 'Long run,Quarterly review') throw new Error(`events ${titles}`);
  const cals = (await api(page, 'GET', '/events/calendars')).body;
  if (!JSON.stringify(cals).includes('Running club')) throw new Error('no Running club calendar');
  await page.goto(`${B}/contacts`);
  await page.getByText('Grace Hopper').first().waitFor();
  await page.goto(`${B}/notes`);
  await page.getByRole('heading', { name: 'Packing' }).waitFor();
  await page.goto(`${B}/tasks`);
  await page.getByText('Garden').first().waitFor();
  await page.goto(`${B}/drive`);
  await page.getByText(/From Google \d{4}/).first().dblclick();
  await page.getByText('Plans').first().waitFor();
});
await step('bringing it in again adds nothing twice', async () => {
  await page.goto(`${B}/settings`);
  const card = page.getByRole('region', { name: 'Move here from another service' });
  await card.getByLabel('Your Google Workspace or Gmail export (.zip)').setInputFiles(await takeout());
  await page.getByText(/From Google: brought in .*0 events, 0 contacts/).waitFor({ timeout: 30000 });
});
await step('on a phone the choices stack and nothing slides sideways', async () => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.reload();
  const card = page.getByRole('region', { name: 'Move here from another service' });
  await card.getByRole('button', { name: 'Zoho Workplace or Zoho Mail' }).click();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('wider than the phone');
  if (await card.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) throw new Error('card overflows');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SP}/shots/movehere-phone.png` });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
