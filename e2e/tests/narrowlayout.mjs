// Each app's main screen at narrower windows (a laptop, a small laptop with a panel open, a tablet): the
// screen's heading is readable (not squeezed to a sliver, not under a button or a field). Found once by
// chance in Chat's header with a thread open; this looks everywhere.
import { chromium } from 'playwright';
import { layoutProblems } from './lib/layoutcheck.mjs';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
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

const problems = () => layoutProblems(page);

const SCREENS = [['Home', '/home'], ['Mail', '/mail'], ['Drive', '/drive'], ['Calendar', '/calendar'], ['Chat', '/chat'], ['Tasks', '/tasks'],
  ['Contacts', '/contacts'], ['Notes', '/notes'], ['Forms', '/forms'], ['Meet', '/meet'], ['Settings', '/settings'], ['Admin', '/admin']];
const WIDTHS = [1280, 1024, 820, 390];
const found = [];
await step('setup: a channel with a thread, a list with tasks', async () => {
  const general = (await api('GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  const top = (await api('POST', `/chat/channels/${general}/messages`, { body: 'Planning the offsite' })).body;
  await api('POST', `/chat/channels/${general}/messages`, { body: 'Lake or city?', thread_id: top.id });
  SCREENS.push(['Chat with a thread open', `/chat/${general}?msg=${top.id}&thread=${top.id}`]);
  // The editors, a form, a task list and a note, and Admin's and Settings' pages.
  for (const kind of ['doc', 'sheet', 'slides']) {
    const f = (await api('POST', '/files/new', { kind, name: `Quarterly ${kind} review` })).body;
    SCREENS.push([`${kind} editor`, `/${kind === 'doc' ? 'docs' : kind === 'sheet' ? 'sheets' : 'slides'}/${f.id}`]);
  }
  const form = (await api('POST', '/forms', { title: 'Team lunch preferences' })).body;
  if (form?.id) SCREENS.push(['form editor', `/forms/${form.id}`]);
  const list = (await api('POST', '/tasks/lists', { name: 'Launch checklist' })).body;
  if (list?.id) { await api('POST', `/tasks/lists/${list.id}/tasks`, { title: 'Book the venue' }); SCREENS.push(['task list', `/tasks/${list.id}`]); }
  for (const tab of ['company', 'checkup', 'links', 'system', 'reports', 'phishing', 'announcements', 'apps', 'storage', 'activity', 'drives']) SCREENS.push([`Admin ${tab}`, `/admin?tab=${tab}`]);
});
for (const width of WIDTHS) {
  await step(`every screen at ${width}px: headings readable, nothing over them`, async () => {
    await page.setViewportSize({ width, height: 860 });
    for (const [name, path] of SCREENS) {
      await page.goto(`${B}${path}`);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      const p = await problems();
      if (name === 'Calendar' && width === 820) await page.screenshot({ path: `${SP}/shots/calendar-820.png` });
      if (p.length) { found.push(`${name} at ${width}px: ${p.join('; ')}`); await page.screenshot({ path: `${SP}/shots/narrow-${name.replace(/\W+/g, '_')}-${width}.png` }); }
    }
    const here = found.filter((f) => f.includes(` at ${width}px`));
    if (here.length) throw new Error(here.join(' | '));
  });
}
await step('the check itself: Chat’s old header (before its fix) is caught', async () => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${B}${SCREENS.find(([n]) => n === 'Chat with a thread open')[1]}`);
  await page.getByRole('complementary', { name: 'Thread' }).waitFor();
  await page.addStyleTag({ content: '.chat-head { flex-wrap: nowrap !important; } .chat-head > .grow { flex: 1 1 0 !important; min-width: 0 !important; } .chat-head h1 { white-space: normal !important; }' });
  await page.waitForTimeout(300);
  const p = await problems();
  if (!p.some((x) => /general/.test(x))) {
    const dbg = await page.evaluate(() => { const h = document.querySelector('.chat-head h1'); const r = h.getBoundingClientRect(); return { w: r.width, h: r.height, lh: getComputedStyle(h).lineHeight, fs: getComputedStyle(h).fontSize, text: h.textContent }; });
    throw new Error(`not caught: ${JSON.stringify(p)} ${JSON.stringify(dbg)}`);
  }
});
await step('the check itself: Calendar’s old toolbar on a tablet (view switch off the edge) is caught', async () => {
  await page.setViewportSize({ width: 820, height: 860 });
  await page.goto(`${B}/calendar`);
  await page.getByRole('radiogroup', { name: 'View' }).waitFor();
  await page.addStyleTag({ content: '.cal-head { flex-wrap: nowrap !important; } .cal-head h1 { white-space: normal !important; }' });
  await page.waitForTimeout(300);
  const p = await problems();
  if (!p.some((x) => /Schedule|Year/.test(x) && /off the edge/.test(x))) throw new Error(`not caught: ${JSON.stringify(p)}`);
});
console.log(`checked ${SCREENS.length} screens: ${SCREENS.map(([n]) => n).join(', ')}`);
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
