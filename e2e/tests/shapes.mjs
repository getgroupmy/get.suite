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
let deckId;
const stored = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content.slides[0].items;
await step('setup: an empty presentation', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Shapes', content: { theme: 'light', slides: [{ id: 's1', items: [] }] } })).body.id;
  await page.goto(`${B}/slides/${deckId}`);
  await page.locator('.slide-stage .slide').waitFor();
});
const KINDS = [['Triangle', 'triangle'], ['Diamond', 'diamond'], ['Block arrow', 'arrowblock'], ['Chevron', 'chevron'], ['Star', 'star'], ['Speech bubble', 'callout']];
await step('Each new shape from the Shape menu, drawn by its outline', async () => {
  for (const [label, kind] of KINDS) {
    await page.getByRole('button', { name: 'Shape ▾' }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    const el = page.locator(`.slide-stage .slide-shape.${kind}`);
    await el.waitFor();
    const clip = await el.evaluate((x) => getComputedStyle(x).clipPath);
    if (!clip.startsWith('polygon')) throw new Error(`${kind}: ${clip}`);
  }
  await until(async () => (await stored()).map((i) => i.shape).join() === KINDS.map((k) => k[1]).join());
});
await step('Words in the speech bubble stay in the bubble, not the tail', async () => {
  await page.locator('.slide-stage .slide-shape.callout').dblclick();
  await page.getByLabel('Text in the shape').waitFor();
  await page.keyboard.type('Hello!');
  await page.keyboard.press('Escape');
  const text = page.locator('.slide-stage .slide-shape.callout .shape-text');
  await text.getByText('Hello!').waitFor();
  const [b, t] = await Promise.all([page.locator('.slide-stage .slide-shape.callout').boundingBox(), text.boundingBox()]);
  if (t.y + t.height > b.y + b.height * 0.75 + 2) throw new Error(`text runs into the tail: ${t.y + t.height} > ${b.y + b.height * 0.75}`);
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await page.screenshot({ path: `${SP}/shots/shapes.png` });
});
await step('The PowerPoint download has the same shapes', async () => {
  await until(async () => (await stored()).some((i) => i.text === 'Hello!'));
  const b64 = await page.evaluate(async (id) => {
    const buf = new Uint8Array(await (await fetch(`/api/files/${id}/export`)).arrayBuffer());
    let s = ''; for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, deckId);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('ppt/slides/slide1.xml').async('string');
  for (const p of ['triangle', 'diamond', 'rightArrow', 'chevron', 'star5', 'wedgeRoundRectCallout']) if (!xml.includes(`prst="${p}"`)) throw new Error('missing ' + p);
  if (!/wedgeRoundRectCallout[\s\S]*?Hello!/.test(xml)) throw new Error('the words are not in the bubble');
});
await step('All six, laid out, with words', async () => {
  const items = KINDS.map(([label, shape], i) => ({ id: `k${i}`, type: 'shape', shape, fill: ['accent', '#188038', '#d93025', '#f9ab00', '#9334e6', '#1a73e8'][i], text: label, x: 4 + (i % 3) * 32, y: 6 + Math.floor(i / 3) * 48, w: 26, h: 40 }));
  const id = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'All shapes', content: { theme: 'light', slides: [{ id: 's1', items }] } })).body.id;
  await page.goto(`${B}/slides/${id}`);
  await page.locator('.slide-stage .slide-shape.callout .shape-text').waitFor();
  const [b, t] = await Promise.all([page.locator('.slide-stage .slide-shape.callout').boundingBox(), page.locator('.slide-stage .slide-shape.callout .shape-text').boundingBox()]);
  const body = b.y + b.height * 0.75;
  if (Math.abs((t.y + t.height / 2) - (b.y + body) / 2) > 0.1 * b.height) throw new Error('bubble text not in the middle of the bubble');
  if (Math.abs((t.x + t.width / 2) - (b.x + b.width / 2)) > 3) throw new Error(`bubble text not centred across: ${t.x + t.width / 2} vs ${b.x + b.width / 2}`);
  await page.screenshot({ path: `${SP}/shots/shapes-all.png` });
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
