// Long names without spaces (a file called Quarterly_Report_Final_Version_…, a colleague with a long
// name, a long channel or task) don't break the screens they show on: the page doesn't scroll sideways,
// and the layout check (headings readable, nothing over them, nothing off the edge) passes.
import { chromium } from 'playwright';
import { layoutProblems } from './lib/layoutcheck.mjs';
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
const LONG = 'Quarterly_Report_Final_Version_2026_Reviewed_By_Legal_And_Finance_Department_Copy';
const SCREENS = [];

await step('setup: long names everywhere', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api('POST', '/users', { local: 'maximiliana', domain: 'acme.com', name: 'Maximiliana-Alexandrina Wolfeschlegelsteinhausenbergerdorff', password: 'password123' });
  const doc = (await api('POST', '/files/new', { kind: 'doc', name: LONG })).body;
  const folder = (await api('POST', '/files/folder', { name: `Folder_${LONG}` })).body;
  const list = (await api('POST', '/tasks/lists', { name: `List_${LONG}` })).body;
  const task = (await api('POST', `/tasks/lists/${list.id}/tasks`, { title: `Task_${LONG}`, due: new Date().toISOString().slice(0, 10) })).body;
  const note = (await api('POST', '/notes', { title: `Note_${LONG}`, body: `https://example.com/${LONG}/${LONG}` })).body;
  await api('POST', '/events', { title: `Event_${LONG}`, start: Date.now() + 3600e3, end: Date.now() + 7200e3 });
  const ch = (await api('POST', '/chat/channels', { name: `channel-${LONG.toLowerCase().replace(/_/g, '-')}`.slice(0, 80) })).body;
  if (ch?.id) await api('POST', `/chat/channels/${ch.id}/messages`, { body: `See ${LONG}${LONG}` });
  SCREENS.push(['Home', '/home'], ['Drive', '/drive'], ['a document', `/docs/${doc.id}`], ['Tasks', `/tasks/${list.id}`], ['a task open', `/tasks/${list.id}?task=${task.id}`],
    ['Notes', '/notes'], ['a note open', `/notes?note=${note.id}`], ['Calendar', '/calendar'], ['Calendar schedule', '/calendar', 'Schedule'], ['Contacts directory', '/contacts?tab=dir'], ['Admin users', '/admin']);
  if (folder?.id) SCREENS.push(['a folder', `/drive/folder/${folder.id}`]);
  if (ch?.id) SCREENS.push(['the channel', `/chat/${ch.id}`]);
});

for (const width of [1280, 390]) {
  await step(`at ${width}px: no page scrolls sideways, and the layout check passes`, async () => {
    await page.setViewportSize({ width, height: 860 });
    const found = [];
    for (const [name, path, view] of SCREENS) {
      await page.goto(`${B}${path}`);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(500);
      if (view) { await page.getByRole('radio', { name: view }).click(); await page.waitForTimeout(400); }
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const p = await layoutProblems(page);
      if (wide > 1) p.unshift(`the page scrolls sideways by ${wide}px`);
      if (p.length) { found.push(`${name}: ${p.join('; ')}`); await page.screenshot({ path: `${SP}/shots/long-${name.replace(/\W+/g, '_')}-${width}.png` }); }
    }
    if (found.length) throw new Error(found.join(' | '));
  });
}
await step('on a phone, the Directory shows the start of a long name (not just …)', async () => {
  await page.setViewportSize({ width: 390, height: 860 });
  await page.goto(`${B}/contacts?tab=dir`);
  const name = page.getByRole('button', { name: /^Maximiliana-Alexandrina/ }).first();
  await name.waitFor();
  // How much of its text is really visible: clipped by every box around it that hides what overflows.
  const shown = await name.evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el);
    let { left, right } = range.getBoundingClientRect();
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== 'visible') { const b = a.getBoundingClientRect(); left = Math.max(left, b.left); right = Math.min(right, b.right); }
    }
    return right - left;
  });
  await page.screenshot({ path: `${SP}/shots/directory-390.png` });
  if (shown < 100) throw new Error(`only ${Math.round(shown)}px of the name shows`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
