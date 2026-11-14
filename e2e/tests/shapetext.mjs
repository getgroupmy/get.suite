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
let deckId, kim;
const stored = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content.slides[0].items;
const shape = (p, id) => p.locator(`.slide-stage [data-item="${id}"]`);
await step('setup: shapes on a slide, shared with a viewer', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const content = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 'box', type: 'shape', shape: 'round', fill: 'accent', x: 10, y: 30, w: 30, h: 25 },
    { id: 'ell', type: 'shape', shape: 'ellipse', fill: '#188038', x: 55, y: 30, w: 25, h: 25 },
    { id: 'ln', type: 'shape', shape: 'line', dir: 'h', fill: 'text', x: 10, y: 80, w: 70, h: 8 },
  ] }] };
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Process', content })).body.id;
  await api(page, 'PUT', `/files/${deckId}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/slides/${deckId}`); await shape(p, 'box').waitFor(); }
});
await step('Double-click a shape and type: the words sit in its middle, for everyone', async () => {
  await shape(page, 'box').dblclick();
  const box = page.getByLabel('Text in the shape');
  await box.waitFor();
  await page.keyboard.type('Step 1: Plan');
  await page.keyboard.press('Escape');
  await box.waitFor({ state: 'detached' });
  await until(async () => (await stored()).find((i) => i.id === 'box').text === 'Step 1: Plan');
  const text = shape(kim, 'box').locator('.shape-text');
  await text.getByText('Step 1: Plan').waitFor();
  const [s, t] = await Promise.all([shape(kim, 'box').boundingBox(), text.boundingBox()]);
  const mid = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const [sx, sy] = mid(s), [tx, ty] = mid(t);
  if (Math.abs(sx - tx) > 3 || Math.abs(sy - ty) > 3) throw new Error(`not centred: ${[sx, sy]} vs ${[tx, ty]}`);
  if (await kim.getByLabel('Text in the shape').count()) throw new Error('viewers cannot type');
  await kim.locator('.slide-stage [data-item="box"]').dblclick();
  if (await kim.getByLabel('Text in the shape').count()) throw new Error('viewers cannot type (double-click)');
});
await step('Bold and size from the toolbar; Enter edits the chosen shape', async () => {
  await shape(page, 'box').click();
  await page.getByRole('button', { name: 'Bold' }).click();
  await page.getByLabel('Text size').selectOption('28');
  await until(async () => { const b = (await stored()).find((i) => i.id === 'box'); return b.bold === true && b.size === 28; });
  if ((await shape(kim, 'box').locator('.shape-text').evaluate((el) => getComputedStyle(el).fontWeight)) !== '700') {
    await until(async () => (await shape(kim, 'box').locator('.shape-text').evaluate((el) => getComputedStyle(el).fontWeight)) === '700');
  }
  await shape(page, 'ell').click();
  await page.keyboard.press('Enter');
  await page.getByLabel('Text in the shape').waitFor();
  await page.keyboard.type('Done');
  await page.keyboard.press('Escape');
  await until(async () => (await stored()).find((i) => i.id === 'ell').text === 'Done');
  // A line holds no text.
  await shape(page, 'ln').dblclick();
  if (await page.getByLabel('Text in the shape').count()) throw new Error('a line took text');
  await page.screenshot({ path: `${SP}/shots/shapetext.png` });
});
await step('Find finds it; the PowerPoint download keeps it in the shape', async () => {
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+f');
  const bar = page.getByRole('search', { name: 'Find in presentation' });
  await bar.getByLabel('Find', { exact: true }).fill('plan');
  await bar.getByLabel('Current match').getByText('Slide 1 · Shape:').waitFor();
  await bar.getByLabel('Find', { exact: true }).press('Escape');
  const b64 = await page.evaluate(async (id) => {
    const buf = new Uint8Array(await (await fetch(`/api/files/${id}/export`)).arrayBuffer());
    let s = ''; for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, deckId);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('ppt/slides/slide1.xml').async('string');
  const sp = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((x) => x.includes('Step 1: Plan'));
  if (!sp || !/prst="roundRect"/.test(sp) || !/<a:solidFill>/.test(sp)) throw new Error('the text is not in the rounded shape');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
