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
let deck;
const order = async () => (await api(page, 'GET', `/files/${deck.id}/content`)).body.content.slides.map((s) => s.items[0]?.text).join(',');
const text = (t) => ({ id: `t${t}`, type: 'text', text: t, x: 10, y: 10, w: 80, h: 20, size: 40 });
await step('grid view shows every slide; drag one to the front', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch', content: { theme: 'light', slides: ['S1', 'S2', 'S3', 'S4', 'S5'].map((t, i) => ({ id: `s${i + 1}`, items: [text(t)] })) } })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: '⊞ Grid view' }).click();
  const g = page.getByRole('list', { name: 'All slides' });
  await g.getByRole('button', { name: 'Slide 5' }).waitFor();
  await g.getByRole('listitem').nth(4).dragTo(g.getByRole('listitem').nth(0), { targetPosition: { x: 5, y: 40 } });
  await until(async () => (await order()) === 'S5,S1,S2,S3,S4');
});
await step('choose several, then duplicate, skip and delete them together', async () => {
  const g = page.getByRole('list', { name: 'All slides' });
  await g.getByRole('button', { name: 'Slide 2' }).click();
  await g.getByRole('button', { name: 'Slide 3' }).click({ modifiers: ['Control'] });
  await page.getByText('2 slides selected').waitFor();
  const bar = page.getByRole('toolbar', { name: 'Selected slides' });
  await bar.getByRole('button', { name: 'Duplicate' }).click();
  await until(async () => (await order()) === 'S5,S1,S2,S1,S2,S3,S4');
  await bar.getByRole('button', { name: 'Skip / show' }).click(); // the copies (now chosen)
  await until(async () => { const s = (await api(page, 'GET', `/files/${deck.id}/content`)).body.content.slides; return s[3].skip && s[4].skip && !s[1].skip; });
  await bar.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete 2 slides?' }).getByRole('button', { name: 'Delete' }).click();
  await until(async () => (await order()) === 'S5,S1,S2,S3,S4');
});
await step('several dragged at once keep their order', async () => {
  const g = page.getByRole('list', { name: 'All slides' });
  await g.getByRole('button', { name: 'Slide 1' }).click();
  await g.getByRole('button', { name: 'Slide 2' }).click({ modifiers: ['Shift'] });
  await g.getByRole('listitem').nth(0).dragTo(g.getByRole('listitem').nth(4), { targetPosition: { x: 200, y: 40 } });
  await until(async () => (await order()) === 'S2,S3,S4,S5,S1');
});
await step('double-click opens a slide; the side list can be dragged too', async () => {
  await page.getByRole('list', { name: 'All slides' }).getByRole('button', { name: 'Slide 3' }).dblclick();
  await page.getByText('Slide 3 of 5').waitFor();
  const side = page.getByRole('list', { name: 'Slides' });
  await side.getByRole('listitem').nth(4).dragTo(side.getByRole('listitem').nth(0), { targetPosition: { x: 40, y: 3 } });
  await until(async () => (await order()) === 'S1,S2,S3,S4,S5');
});
await step('choose several in the grid and copy them to another presentation, or a new one', async () => {
  const board = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Board deck', content: { slides: [{ id: 'b1', items: [text('Mine')] }] } })).body;
  const g = page.getByRole('list', { name: 'All slides' });
  if (!(await g.count())) await page.getByRole('button', { name: '⊞ Grid view' }).click();
  await g.getByRole('button', { name: 'Slide 2' }).click();
  await g.getByRole('button', { name: 'Slide 4' }).click({ modifiers: ['Control'] });
  await page.getByText('2 slides selected').waitFor();
  const bar = page.getByRole('toolbar', { name: 'Selected slides' });
  await bar.getByRole('button', { name: 'Copy to ▾' }).click();
  await page.getByRole('menuitem', { name: 'Another presentation…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Copy 2 slides to a presentation' });
  await dlg.getByLabel('Search your files').fill('Board deck');
  await dlg.getByRole('button', { name: /Board deck/ }).click();
  await page.locator('.toast', { hasText: 'Copied 2 slides to “Board deck”, from slide 2' }).waitFor();
  const texts = async (id) => (await api(page, 'GET', `/files/${id}/content`)).body.content.slides.map((x) => x.items[0]?.text).join(',');
  await until(async () => (await texts(board.id)) === 'Mine,S2,S4');
  await bar.getByRole('button', { name: 'Copy to ▾' }).click();
  await page.getByRole('menuitem', { name: 'A new presentation' }).click();
  const t = page.locator('.toast', { hasText: 'Copied to a new presentation, “Pitch – 2 slides”' });
  await t.waitFor();
  await t.getByRole('button', { name: 'Open it' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith(deck.id));
  await page.getByRole('button', { name: 'Slide 2', exact: true }).waitFor();
  if (await page.getByRole('button', { name: 'Slide 3', exact: true }).count()) throw new Error('more than the two');
  if ((await order()) !== 'S1,S2,S3,S4,S5') throw new Error('the original changed');
});
await step('a slide → Add slide to Tasks: a task named after the slide that opens the presentation on it', async () => {
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: 'Slide 4', exact: true }).click();
  await page.getByRole('button', { name: 'Options for slide 4' }).click();
  await page.getByRole('menuitem', { name: 'Add slide to Tasks' }).click();
  await page.locator('.toast', { hasText: /^Added to / }).last().getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(/\/tasks\/[\w-]+\?task=/);
  const d = page.getByRole('complementary', { name: 'Task details' });
  if ((await d.getByLabel('Task', { exact: true }).inputValue()) !== 'S4') throw new Error(await d.getByLabel('Task', { exact: true }).inputValue());
  const link = d.getByRole('link', { name: /Slide 4: / });
  if (!(await link.textContent()).includes('🖼')) throw new Error(await link.textContent());
  await link.click();
  await page.waitForURL(/\/slides\//);
  await page.getByText('Slide 4 of 5').waitFor();
  // The presentation's header counts it (a task about one of its slides is about the presentation).
  await page.getByRole('button', { name: '1 task to do about this file' }).click();
  await page.getByRole('menuitem', { name: 'S4' }).waitFor();
  await page.keyboard.press('Escape');
});
await step('Copy link to slide: the link opens the presentation on that slide', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: 'Slide 3', exact: true }).click();
  await page.getByRole('button', { name: 'Options for slide 3' }).click();
  await page.getByRole('menuitem', { name: 'Copy link to slide' }).click();
  await page.locator('.toast', { hasText: 'Link to slide 3 copied' }).waitFor();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  const third = (await api(page, 'GET', `/files/${deck.id}/content`)).body.content.slides[2];
  if (url !== `${B}/slides/${deck.id}#slide=${third.id}`) throw new Error(url);
  await page.goto(`${B}/drive`);
  await page.goto(url);
  await page.getByText('Slide 3 of 5').waitFor();
  // A link to another of its slides opened while it's open moves there
  const fifth = (await api(page, 'GET', `/files/${deck.id}/content`)).body.content.slides[4];
  await page.evaluate((sid) => { window.location.hash = `#slide=${sid}`; }, fifth.id);
  await page.getByText('Slide 5 of 5').waitFor();
  await page.goto(`${B}/drive`); // (a new page: the same address with another #… only moves within it)
  await page.goto(`${B}/slides/${deck.id}#slide=gone-slide`);
  await page.locator('.toast', { hasText: 'That slide is no longer in the presentation' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
