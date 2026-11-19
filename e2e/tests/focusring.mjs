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
// Keyboard users can see where they are: every element Tab reaches shows a focus ring (outline or box-shadow).
const VISIBLE = () => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        if (e.isContentEditable && e.closest('.ProseMirror, .tiptap')) return null; // a writing area: the text cursor shows where you are
        const chain = [e, e.parentElement, e.parentElement?.parentElement, e.parentElement?.parentElement?.parentElement].filter(Boolean);
        const look = () => chain.map((x) => { const c = getComputedStyle(x); return [c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.borderTopColor, c.borderBottomColor, c.backgroundColor, c.textDecorationLine].join('|'); }).join('/');
        const focused = look();
        const sel = e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? [e.selectionStart, e.selectionEnd] : null;
        e.blur();
        const unfocused = look();
        e.focus({ focusVisible: true });
        if (sel) try { e.setSelectionRange(...sel); } catch { /* not every input type */ }
        if (focused !== unfocused) return null;
        return `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? `.${e.className.trim().split(/\s+/).join('.')}` : ''} “${(e.getAttribute('aria-label') || e.innerText || e.value || '').trim().slice(0, 40)}”`;
      };
const PAGES = ['/home', '/drive', '/mail', '/calendar', '/tasks', '/notes', '/chat', '/contacts', '/forms', '/settings', '/admin?tab=company'];
for (const path of process.env.ONLY ? [process.env.ONLY] : PAGES) {
  await step(`focus is visible: ${path}`, async () => {
    await page.goto(`${B}${path}`);
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.activeElement?.blur());
    const bad = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      // Visible: the element (or one of its three nearest containers) looks different focused than not:
      // an outline, a shadow, a border or background colour.
      const r = await page.evaluate(VISIBLE);
      if (r && !bad.includes(r)) bad.push(r);
    }
    if (bad.length) throw new Error(bad.slice(0, 8).join(' ; '));
  });
}
await step('editors: documents, spreadsheets, presentations (their toolbars)', async () => {
  const all = [];
  for (const kind of ['doc', 'sheet', 'slides']) {
    const f = (await api(page, 'POST', '/files/new', { kind, name: `Focus ${kind}` })).body;
    await page.goto(`${B}/${{ doc: 'docs', sheet: 'sheets', slides: 'slides' }[kind]}/${f.id}`);
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.activeElement?.blur());
    const bad = [];
    for (let i = 0; i < 70; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(VISIBLE);
      if (r && !bad.includes(r)) bad.push(r);
    }
    if (bad.length) all.push(`${kind}: ${bad.slice(0, 8).join(' ; ')}`);
  }
  if (all.length) throw new Error(all.join(' || '));
});
const tabThrough = async (n) => {
  const bad = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(VISIBLE);
    if (r && !bad.includes(r)) bad.push(r);
  }
  return bad;
};
await step('dialogs: a new calendar event, sharing a file', async () => {
  const all = [];
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('dialog', { name: 'New event' }).waitFor();
  let bad = await tabThrough(40);
  if (bad.length) all.push(`event: ${bad.slice(0, 8).join(' ; ')}`);
  await page.keyboard.press('Escape');
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Focus doc' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  await page.getByRole('dialog', { name: /Share “Focus doc”/ }).waitFor();
  bad = await tabThrough(30);
  if (bad.length) all.push(`share: ${bad.slice(0, 8).join(' ; ')}`);
  if (all.length) throw new Error(all.join(' || '));
});
await step('the bell: each notification, its own buttons (read, snooze, remove) and the snooze times', async () => {
  // Someone else shares files with Olivia, so there's something in her bell.
  await api(page, 'POST', '/users', { local: 'ringo', domain: 'acme.com', name: 'Ringo Ring', password: 'password123' });
  const ringo = await mk('ringo');
  await ringo.goto(B);
  await ringo.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ringo@acme.com', password: 'password123' }) }));
  const olivia = (await api(ringo, 'GET', '/users/directory')).body.find((u) => u.name === 'Olivia Owner').id;
  for (const name of ['Budget', 'Plan']) {
    const f = (await api(ringo, 'POST', '/files/new', { kind: 'doc', name })).body;
    await api(ringo, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: olivia, role: 'viewer' }], message: `About ${name}` });
  }
  await ringo.context().close();
  await page.goto(`${B}/home`);
  await page.getByRole('button', { name: /^Notifications, 2 new/ }).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await panel.getByText('Ringo Ring shared “Plan” with you').waitFor();
  const all = [];
  let bad = await tabThrough(16);
  if (bad.length) all.push(`bell: ${bad.slice(0, 8).join(' ; ')}`);
  // The snooze times, opened from the keyboard.
  // Its buttons show once a notification has focus: Tab from it reaches Snooze.
  await panel.locator('.bell-item').first().focus();
  await page.keyboard.press('Tab');
  const on = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
  if (!/^Snooze: /.test(on)) throw new Error(`Tab from a notification went to “${on}”, not its Snooze`);
  await page.keyboard.press('Enter');
  await panel.getByRole('group', { name: 'Snooze until' }).waitFor();
  bad = await tabThrough(4);
  if (bad.length) all.push(`snooze: ${bad.slice(0, 8).join(' ; ')}`);
  if (all.length) throw new Error(all.join(' || '));
});
await step('panels and views: a task open, a note open, Calendar’s week', async () => {
  const all = [];
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Focus list' })).body;
  const t = (await api(page, 'POST', `/tasks/lists/${list.id}/tasks`, { title: 'Focus task' })).body;
  const note = (await api(page, 'POST', '/notes', { title: 'Focus note', body: 'x' })).body;
  for (const [name, path, view] of [['task', `/tasks/${list.id}?task=${t.id}`], ['note', `/notes?note=${note.id}`], ['week', '/calendar', 'Week']]) {
    await page.goto(`${B}${path}`);
    await page.waitForTimeout(1200);
    if (view) await page.getByRole('radio', { name: view }).click();
    await page.evaluate(() => document.activeElement?.blur());
    const bad = await tabThrough(40);
    if (bad.length) all.push(`${name}: ${bad.slice(0, 8).join(' ; ')}`);
  }
  if (all.length) throw new Error(all.join(' || '));
});
await step('Mail’s search box shows focus too', async () => {
  await page.goto(`${B}/mail`);
  await page.waitForTimeout(1500);
  if (!(await page.locator('.mail-search input').count())) { console.log('SKIP (Email isn’t set up in this run): Mail’s search box'); return; }
  await page.locator('.mail-search input').focus();
  const ring = await page.locator('.mail-search').evaluate((el) => getComputedStyle(el).outlineStyle);
  if (ring === 'none') throw new Error('no ring on the Mail search box');
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
