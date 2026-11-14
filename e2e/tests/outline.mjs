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
const el = (p, id, sel) => p.locator(`.slide-stage [data-item="${id}"] ${sel}`);
const css = (loc, prop) => loc.evaluate((x, pr) => getComputedStyle(x)[pr], prop);
await step('setup: a shape, a text box and a star, shared with a viewer', async () => {
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
    { id: 'r', type: 'shape', shape: 'rect', fill: '#e8f0fe', x: 5, y: 10, w: 30, h: 35 },
    { id: 't', type: 'text', role: 'body', text: 'Key point', x: 45, y: 10, w: 40, h: 20, size: 28 },
    { id: 'st', type: 'shape', shape: 'star', fill: 'accent', x: 10, y: 55, w: 20, h: 35 },
  ] }] };
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Boxes', content })).body.id;
  await api(page, 'PUT', `/files/${deckId}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/slides/${deckId}`); await el(p, 't', '.slide-text').waitFor(); }
});
await step('An outline round the rectangle, 4 pt, for everyone', async () => {
  await page.locator('.slide-stage [data-item="r"]').click();
  if (await page.getByLabel('Outline thickness').count()) throw new Error('thickness before an outline');
  await page.getByLabel('Outline', { exact: true }).selectOption({ label: 'Outline: Blue' });
  await page.getByLabel('Outline thickness').selectOption('4');
  await until(async () => { const r = (await stored()).find((i) => i.id === 'r'); return r.outline === '#1a73e8' && r.outlineW === 4; });
  await until(async () => (await css(el(kim, 'r', '.slide-shape'), 'borderTopStyle')) === 'solid');
  const w = parseFloat(await css(el(kim, 'r', '.slide-shape'), 'borderTopWidth'));
  const slideW = (await kim.locator('.slide-stage .slide').boundingBox()).width;
  if (Math.abs(w - 4 * slideW / 960) > 0.6) throw new Error(`outline ${w}px, slide ${slideW}px`);
  if ((await css(el(kim, 'r', '.slide-shape'), 'borderTopColor')) !== 'rgb(26, 115, 232)') throw new Error('colour');
});
await step('A text box gets a box colour and an outline', async () => {
  await page.locator('.slide-stage [data-item="t"]').click();
  await page.getByLabel('Box colour').selectOption({ label: 'Box: Light yellow' });
  await page.getByLabel('Outline', { exact: true }).selectOption({ label: 'Outline: Black' });
  await until(async () => { const t = (await stored()).find((i) => i.id === 't'); return t.fill === '#fef7e0' && t.outline === '#202124' && t.outlineW === undefined; });
  await until(async () => (await css(el(kim, 't', '.slide-text'), 'backgroundColor')) === 'rgb(254, 247, 224)');
  await page.screenshot({ path: `${SP}/shots/outline.png` });
  // Taking the outline away takes the thickness too.
  await page.getByLabel('Outline', { exact: true }).selectOption({ label: 'No outline' });
  await until(async () => { const t = (await stored()).find((i) => i.id === 't'); return !t.outline && !t.outlineW; });
  await until(async () => (await css(el(kim, 't', '.slide-text'), 'borderTopStyle')) === 'none');
});
await step('A star has no outline to offer; viewers have no controls', async () => {
  await page.locator('.slide-stage [data-item="st"]').click();
  await page.getByLabel('Shape colour').waitFor();
  if (await page.getByLabel('Outline', { exact: true }).count()) throw new Error('outline offered for a star');
  await kim.locator('.slide-stage [data-item="r"]').click({ force: true });
  if (await kim.getByLabel('Outline', { exact: true }).count()) throw new Error('viewer has controls');
});
await step('The PowerPoint download keeps them', async () => {
  const b64 = await page.evaluate(async (id) => {
    const buf = new Uint8Array(await (await fetch(`/api/files/${id}/export`)).arrayBuffer());
    let s = ''; for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  }, deckId);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const xml = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('ppt/slides/slide1.xml').async('string');
  if (!/<a:ln w="50800"><a:solidFill><a:srgbClr val="1A73E8"\/>/.test(xml)) throw new Error('no 4 pt blue outline');
  const t = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((x) => x.includes('Key point'));
  if (!/<a:solidFill><a:srgbClr val="FEF7E0"\/>/.test(t)) throw new Error('the text box lost its colour');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
