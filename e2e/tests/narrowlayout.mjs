// Each app's main screen at narrower windows (a laptop, a small laptop with a panel open, a tablet): the
// screen's heading is readable (not squeezed to a sliver, not under a button or a field). Found once by
// chance in Chat's header with a thread open; this looks everywhere.
import { chromium } from 'playwright';
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

/**
 * What's wrong with the screen's main headings (h1, and the h2s of a header bar): one squeezed narrower
 * than a few letters while it has more to show, or one overlapped by a button, link, field or menu.
 */
const problems = () => page.evaluate(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const heads = [...document.querySelectorAll('main h1, [role="main"] h1, .chat-head h1, .page-head h1, header h1')].filter((el) => { const r = el.getBoundingClientRect(), st = getComputedStyle(el); return r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; }); // (a heading squeezed to no width still counts)
  const controls = [...document.querySelectorAll('button, a[href], select, input:not([type="hidden"]), [role="button"], [role="combobox"]')].filter(seen);
  const out = [];
  const over = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 6 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 6;
  for (const h of heads) {
    const r = h.getBoundingClientRect();
    const text = h.textContent.trim();
    if (!text) continue;
    // Under a panel or dialog laid over the screen (a thread on a phone covers the conversation): not shown, so fine.
    const top = document.elementFromPoint(Math.min(Math.max(r.left + 4, 0), window.innerWidth - 1), r.top + r.height / 2);
    const cover = top?.closest('[role="complementary"], [role="dialog"], aside, .modal');
    if (cover && !cover.contains(h)) continue;
    // Squeezed: a heading of several letters given less room than three of them, or wrapped to a word a line.
    const lineHeight = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize) * 1.3;
    if (text.length > 3 && r.width < 48) out.push(`“${text}” squeezed to ${Math.round(r.width)}px`);
    else if (text.split(/\s+/).length > 1 && (r.height > lineHeight * 3.2 || Math.round(r.height / lineHeight) >= text.split(/\s+/).length)) out.push(`“${text}” wrapped to ${Math.round(r.height / lineHeight)} lines in ${Math.round(r.width)}px`);
    // Controls in its toolbar cut off at the window's edge (and so out of reach).
    const bar = h.parentElement;
    for (const c of [...bar.querySelectorAll('button, a[href], select, input')].filter(seen)) {
      const q = c.getBoundingClientRect();
      if (q.right > window.innerWidth + 1) { out.push(`“${(c.getAttribute('aria-label') || c.textContent || '').trim().slice(0, 30)}” beside “${text}” goes off the edge`); break; }
    }
    // Other text drawn over its words (a label beside it that didn't make room).
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || h.contains(n) || !seen(n.parentElement)) continue;
      const tr = document.createRange(); tr.selectNodeContents(n);
      const hit = [...tr.getClientRects()].find((x) => x.width > 0 && Math.abs(x.top - r.top) < r.height + 40 && [...(() => { const k = document.createRange(); k.selectNodeContents(h); return k.getClientRects(); })()].some((t) => over(t, x)));
      if (hit) { out.push(`“${text}” under the text “${n.textContent.trim().slice(0, 30)}”`); break; }
    }
    // Where its words actually are (a heading's box spans the whole row, its text needn't).
    const range = document.createRange(); range.selectNodeContents(h);
    const words = [...range.getClientRects()].filter((x) => x.width > 0);
    for (const c of controls) {
      if (h.contains(c) || c.contains(h)) continue;
      const q = c.getBoundingClientRect();
      // More than a sliver of the text under the control is an overlap.
      if (words.some((t) => over(t, q))) out.push(`“${text}” under ${c.tagName.toLowerCase()} “${(c.getAttribute('aria-label') || c.textContent || c.value || '').trim().slice(0, 30)}”`);
    }
  }
  // Anywhere on the screen: a button or field past the window's edge that nothing scrolls to (a toolbar
  // that scrolls sideways is fine).
  const W = window.innerWidth;
  for (const c of controls) {
    const q = c.getBoundingClientRect();
    if (q.right <= W + 1 && q.left >= -1) continue;
    let scrolls = false;
    for (let a = c.parentElement; a && a !== document.body; a = a.parentElement) {
      const st = getComputedStyle(a);
      if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && a.scrollWidth > a.clientWidth) { scrolls = true; break; }
      // A drawer kept wholly off-screen until it's opened (the phone's app list) isn't cut off.
      if ((st.position === 'fixed' || st.position === 'absolute') && (() => { const b = a.getBoundingClientRect(); return b.right <= 0 || b.left >= W; })()) { scrolls = true; break; }
    }
    if (!scrolls && !c.closest('[aria-hidden="true"], .sr-only, .visually-hidden')) { out.push(`${c.tagName.toLowerCase()} “${(c.getAttribute('aria-label') || c.textContent || c.placeholder || '').trim().slice(0, 30)}” off the edge (${Math.round(q.left)}–${Math.round(q.right)} of ${W})`); }
  }
  return out;
});

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
