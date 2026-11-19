// On a touch screen there's no pointing at things: buttons kept invisible until the pointer is over their
// row (a tile's ⋮, a notification's buttons, a folder's menu…) must show without it. On a phone and a tablet
// (touch, no hover), no button on the main screens is left see-through.
import { chromium, devices } from 'playwright';
import { textOverlaps } from './lib/layoutcheck.mjs';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
let page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const SCREENS = [];
let cookies;

await step('setup: something in each app, and a notification', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const doc = (await api('POST', '/files/new', { kind: 'doc', name: 'Touch doc' })).body;
  await api('POST', '/files/folder', { name: 'Touch folder' });
  const deck = (await api('POST', '/files/new', { kind: 'slides', name: 'Touch deck' })).body;
  const list = (await api('POST', '/tasks/lists', { name: 'Touch list' })).body;
  await api('POST', `/tasks/lists/${list.id}/tasks`, { title: 'Touch task' });
  await api('POST', '/notes', { title: 'Touch note', body: 'x' });
  const general = (await api('GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await api('POST', `/chat/channels/${general}/messages`, { body: 'Hello from a phone' });
  // Someone shares a file with Olivia: a notification in her bell.
  await api('POST', '/users', { local: 'tara', domain: 'acme.com', name: 'Tara Touch', password: 'password123' });
  const other = await (await browser.newContext()).newPage();
  await other.goto(B);
  await other.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tara@acme.com', password: 'password123' }) }));
  const oid = (await other.evaluate(async () => (await fetch('/api/users/directory', { headers: { 'x-requested-with': 'nas-workspace' } })).json())).find((u) => u.name === 'Olivia Owner').id;
  await other.evaluate(async (id) => { const f = await (await fetch('/api/files/new', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'doc', name: 'From Tara' }) })).json(); await fetch(`/api/files/${f.id}/shares`, { method: 'PUT', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ shares: [{ user_id: id, role: 'viewer' }] }) }); }, oid);
  await other.context().close();
  cookies = await page.context().cookies();
  SCREENS.push(['Drive', '/drive'], ['Drive as a grid', '/drive', 'Grid'], ['a document', `/docs/${doc.id}`], ['a presentation', `/slides/${deck.id}`], ['Tasks', `/tasks/${list.id}`],
    ['Notes', '/notes'], ['Chat', `/chat/${general}`], ['Home', '/home'], ['the bell', '/home', 'bell'], ['Contacts', '/contacts?tab=dir'], ['Calendar', '/calendar']);
  const sheet = (await api('POST', '/files/new', { kind: 'sheet', name: 'Touch sheet' })).body;
  const form = (await api('POST', '/forms', { title: 'Touch form' })).body;
  SCREENS.push(['a spreadsheet', `/sheets/${sheet.id}`], ['Settings', '/settings'], ['Admin', '/admin'], ['a new event', '/calendar', 'Create'], ['Meet', '/meet']);
  if (form?.id) SCREENS.push(['a form', `/forms/${form.id}`]);
});

// Buttons drawn see-through (opacity 0, themselves or a container), that a touch can't reveal.
const hidden = () => page.evaluate(() => [...document.querySelectorAll('button, a[href], [role="button"]')].filter((el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
  const st = getComputedStyle(el);
  if (st.visibility === 'hidden' || st.display === 'none' || el.closest('[aria-hidden="true"], .sr-only')) return false;
  for (let a = el; a; a = a.parentElement) if (Number(getComputedStyle(a).opacity) === 0) return true;
  return false;
}).map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)));

for (const [label, device] of [['phone', devices['Pixel 7']], ['tablet', devices['Galaxy Tab S4']]]) {
  await step(`on a ${label} (touch, no hover): no button left invisible`, async () => {
    const ctx = await browser.newContext({ ...device });
    await ctx.addCookies(cookies);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    if (!(await page.evaluate(() => matchMedia('(hover: none)').matches))) throw new Error('the browser still says it can hover');
    const found = [];
    for (const [name, path, open] of SCREENS) {
      await page.goto(`${B}${path}`);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(600);
      if (open === 'bell') { await page.getByRole('button', { name: /^Notifications/ }).click(); await page.getByRole('dialog', { name: 'Notifications' }).waitFor(); }
      else if (open) { const b = page.getByRole('button', { name: open, exact: true }); if (await b.count()) await b.click(); await page.waitForTimeout(300); }
      const h = [...new Set(await hidden())];
      if (h.length) { found.push(`${name}: ${h.join(', ')}`); await page.screenshot({ path: `${SP}/shots/touch-${label}-${name.replace(/\W+/g, '_')}.png` }); }
    }
    if (found.length) throw new Error(found.join(' | '));
  });
}
await step('on a phone, tapping a note’s ✓ selects it', async () => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.addCookies(cookies);
  page = await ctx.newPage();
  await page.goto(`${B}/notes`);
  const pick = page.getByRole('button', { name: 'Select note: Touch note' });
  await pick.tap();
  await page.waitForFunction(() => document.querySelector('.note-select[aria-pressed="true"]'));
  await page.screenshot({ path: `${SP}/shots/note-picked-phone.png` });
});
await step('on a phone, buttons are big enough to tap (24×24, or room around them: WCAG 2.5.8)', async () => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.addCookies(cookies);
  page = await ctx.newPage();
  const found = [];
  for (const [name, path, open] of SCREENS) {
    await page.goto(`${B}${path}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(600);
    if (open === 'bell') { await page.getByRole('button', { name: /^Notifications/ }).click(); await page.getByRole('dialog', { name: 'Notifications' }).waitFor(); }
    else if (open) { const b = page.getByRole('button', { name: open, exact: true }); if (await b.count()) { await b.first().click(); await page.waitForTimeout(400); } }
    const small = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, [role="button"], input[type="checkbox"], input[type="radio"], select')].filter((el) => {
        const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && st.visibility !== 'hidden' && !el.closest('[aria-hidden="true"], .sr-only, .ProseMirror, .tiptap');
      });
      const rects = els.map((el) => el.getBoundingClientRect());
      // Too small: under 24px either way, unless a 24px circle around its middle touches no other target (the spacing exception).
      return els.filter((el, i) => {
        const r = rects[i];
        if (r.width >= 24 && r.height >= 24) return false;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return rects.some((o, j) => j !== i && Math.max(o.left - cx, 0, cx - o.right) ** 2 + Math.max(o.top - cy, 0, cy - o.bottom) ** 2 < 12 * 12 && !els[j].contains(el) && !el.contains(els[j]));
      }).map((el, i) => `${(el.getAttribute('aria-label') || el.textContent || el.type || '').trim().slice(0, 30)} (${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)})`);
    });
    await page.screenshot({ path: `${SP}/shots/tap-${name.replace(/\W+/g, '_')}.png` });
    const over = await textOverlaps(page);
    if (small.length || over.length) found.push(`${name}: ${[...new Set(small), ...over].join(', ')}`);
  }
  if (found.length) throw new Error(found.join(' | '));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
