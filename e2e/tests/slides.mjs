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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let deckId;
const content = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content;
// The server stores co-edited changes a couple of seconds after the last one.
const saved = async () => { await page.getByText('All changes saved').waitFor({ timeout: 10000 }); await page.waitForTimeout(2600); };
const stage = () => page.locator('.slide-stage > .slide');
const itemBox = async (label) => page.locator(`.slide-stage [aria-label^="${label}"]`).first().boundingBox();

await step('setup and a new presentation from Drive', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(B + '/drive');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Presentation' }).click();
  await page.waitForURL(/\/slides\//);
  deckId = page.url().split('/').pop();
  await page.getByText('Click to add title').waitFor();
});

await step('type a title and subtitle', async () => {
  await page.getByText('Click to add title').dblclick();
  await page.keyboard.type('Quarterly review');
  await page.getByText('Click to add subtitle').dblclick();
  await page.keyboard.type('Acme Trading, Q4');
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await saved();
  const c = await content();
  if (c.slides[0].items.map((i) => i.text).join('|') !== 'Quarterly review|Acme Trading, Q4') throw new Error(JSON.stringify(c.slides[0].items));
});

await step('format a text box: size, italic, colour', async () => {
  await page.locator('.slide-stage [aria-label^="Text: Quarterly"]').click();
  await page.getByLabel('Text size').selectOption('54');
  await page.getByRole('button', { name: 'Italic' }).click();
  await page.getByLabel('Text colour').selectOption({ label: 'Theme accent' });
  await saved();
  const t = (await content()).slides[0].items[0];
  if (t.size !== 54 || !t.italic || t.color !== 'accent' || !t.bold) throw new Error(JSON.stringify(t));
});

await step('new slide with a layout; drag and resize a box', async () => {
  await page.getByRole('button', { name: 'New slide' }).click();
  await page.getByRole('menuitem', { name: 'Title and text' }).click();
  await page.getByRole('button', { name: 'Slide 2', exact: true }).waitFor();
  await page.getByText('Click to add text').dblclick();
  await page.keyboard.type('Revenue up 12%\nNew office opened');
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  const s = await stage().boundingBox();
  const b = await itemBox('Text: Revenue');
  await page.locator('.slide-stage [aria-label^="Text: Revenue"]').click();
  await page.mouse.move(b.x + 40, b.y + 40);
  await page.keyboard.down('Alt'); // placed freely: no snapping to the smart guides
  await page.mouse.down();
  await page.mouse.move(b.x + 40 + s.width * 0.05, b.y + 40 + s.height * 0.02, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await saved();
  let it = (await content()).slides[1].items[1];
  if (Math.round(it.x) !== 11 || Math.round(it.y) !== 28) throw new Error(`moved to ${it.x}, ${it.y}`);
  const h = await page.locator('.slide-stage .slide-item.sel .handle.se').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x - s.width * 0.2, h.y - s.height * 0.1, { steps: 5 });
  await page.mouse.up();
  await saved();
  it = (await content()).slides[1].items[1];
  if (Math.abs(it.w - 68) > 1.5 || Math.abs(it.h - 54) > 1.5) throw new Error(`size ${it.w} x ${it.h}`);
  await page.screenshot({ path: `${SP}/shots/slides-editor.png` });
});

await step('shapes and pictures; Delete removes the selected item', async () => {
  await page.getByRole('button', { name: 'Shape ▾' }).click();
  await page.getByRole('menuitem', { name: 'Ellipse' }).click();
  await page.locator('.slide-stage [aria-label="Shape"]').waitFor();
  await page.keyboard.press('Delete');
  await page.locator('.slide-stage [aria-label="Shape"]').waitFor({ state: 'detached' });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Picture', exact: true }).click()]);
  await chooser.setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: PNG });
  const img = page.locator('.slide-stage .slide-item.image img');
  await img.waitFor();
  await page.waitForFunction(() => document.querySelector('.slide-stage .slide-item.image img')?.naturalWidth > 0);
  await page.waitForTimeout(1200); await saved();
  const pic = (await content()).slides[1].items.find((i) => i.type === 'image');
  if (!pic || Math.round(pic.w) !== 60) throw new Error(JSON.stringify(pic));
});

await step('slide list: duplicate, move, delete', async () => {
  await page.getByRole('button', { name: 'Options for slide 2' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.getByRole('button', { name: 'Slide 3', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Options for slide 1' }).click();
  await page.getByRole('menuitem', { name: 'Move down' }).click();
  await saved();
  let c = await content();
  if (c.slides.length !== 3 || c.slides[1].items[0].text !== 'Quarterly review') throw new Error('not moved');
  await page.getByRole('button', { name: 'Options for slide 3' }).click();
  await page.getByRole('menuitem', { name: 'Delete slide' }).click();
  await page.getByRole('dialog', { name: 'Delete slide 3?' }).getByRole('button', { name: 'Delete' }).click();
  await saved();
  c = await content();
  if (c.slides.length !== 2) throw new Error(`${c.slides.length} slides`);
});

await step('present: arrows move, Escape ends', async () => {
  await page.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  await p.getByText('1 / 2').waitFor();
  await page.keyboard.press('ArrowRight');
  await p.getByText('2 / 2').waitFor();
  await page.keyboard.press('ArrowRight');
  await p.getByText('2 / 2').waitFor();
  await page.screenshot({ path: `${SP}/shots/slides-present.png` });
  await page.keyboard.press('Escape');
  await p.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Slide 2', exact: true }).and(page.locator('[aria-current="true"]')).waitFor();
});

await step('viewers can present and see pictures, but not edit', async () => {
  await api(page, 'POST', '/users', { local: 'vic', domain: 'acme.com', name: 'Vic Viewer', password: 'password123' });
  const vic = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'vic@acme.com');
  await api(page, 'PUT', `/files/${deckId}/shares`, { shares: [{ user_id: vic.id, role: 'viewer' }] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const v = await ctx.newPage();
  await v.goto(B);
  await v.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'vic@acme.com', password: 'password123' }) }));
  await v.goto(`${B}/slides/${deckId}`);
  await v.getByText('View only.').waitFor();
  if (await v.getByRole('toolbar', { name: 'Slide tools' }).count()) throw new Error('editing tools for a viewer');
  await v.getByRole('button', { name: 'Slide 1', exact: true }).click(); // the picture slide, after the move earlier
  await v.waitForFunction(() => document.querySelector('.slide-stage .slide-item.image img')?.naturalWidth > 0);
  await v.getByRole('button', { name: 'Present', exact: true }).waitFor();
  await ctx.close();
});

await step('phone width', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await stage().waitFor();
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (over) throw new Error('horizontal scroll');
  await page.screenshot({ path: `${SP}/shots/slides-phone.png` });
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
