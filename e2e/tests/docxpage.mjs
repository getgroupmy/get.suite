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
await step('a Word file keeps its page setup: Letter, landscape, narrow margins, header, footer, page numbers', async () => {
  const b64 = (await import('node:fs')).readFileSync(`${ROOT}/e2e/fixtures/office/pack.docx`).toString('base64');
  const up = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=Board%20pack.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
    return r.json();
  }, b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  if (opened.status >= 300) throw new Error(JSON.stringify(opened));
  await page.goto(`${B}/docs/${opened.body.id}`);
  await page.locator('.ProseMirror').getByText('Board pack for November').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  const val = (l) => dlg.getByLabel(l).first().inputValue();
  if (!/^letter$/i.test(await val('Paper size'))) throw new Error('paper ' + await val('Paper size'));
  if (!/^narrow$/i.test(await val('Margins'))) throw new Error('margins ' + await val('Margins'));
  if ((await val('Header (top of every page)')) !== 'Acme Ltd') throw new Error('header');
  if ((await val('Footer (bottom of every page)')) !== 'Private') throw new Error('footer');
  if (!(await dlg.getByLabel('Page numbers in the footer').isChecked())) throw new Error('numbers');
  if (!(await dlg.getByRole('button', { name: 'Landscape' }).or(dlg.getByRole('radio', { name: 'Landscape' })).first().evaluate((el) => el.classList.contains('on') || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true'))) throw new Error('orientation');
  await page.screenshot({ path: `${SP}/shots/docx-page.png` });
});
await step('Normal text goes out to Word and comes back: Georgia, 12 pt; and through an .odt file', async () => {
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Round trip', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'There and back' }] }] } })).body;
  await api(page, 'PATCH', `/files/${d.id}`, { page_setup: { font: 'Georgia', fontSize: 12 } });
  const back = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=docx`)).arrayBuffer();
    const up = await (await fetch('/api/files/upload?name=Round%20trip.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    return (await fetch(`/api/files/${up.id}/open-as`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' } })).json();
  }, d.id);
  await page.goto(`${B}/docs/${back.id}`);
  await page.locator('.ProseMirror').getByText('There and back').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  if ((await dlg.getByLabel('Normal text: font').inputValue()) !== 'Georgia') throw new Error('font ' + await dlg.getByLabel('Normal text: font').inputValue());
  if ((await dlg.getByLabel('Normal text: size').inputValue()) !== '12') throw new Error('size');
  // The OpenDocument download carries it too.
  const b64 = await page.evaluate(async (id) => { const b = new Uint8Array(await (await fetch(`/api/files/${id}/export?format=odt`)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, back.id);
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const styles = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('styles.xml').async('string');
  if (!/fo:font-family="'Georgia'" fo:font-size="12pt"/.test(styles)) throw new Error('odt: ' + styles.slice(0, 300));
  // ...and opening that .odt file brings it back.
  const again = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const up = await (await fetch('/api/files/upload?name=Round%20trip.odt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    return (await fetch(`/api/files/${up.id}/open-as`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' } })).json();
  }, b64);
  await page.goto(`${B}/docs/${again.id}`);
  await page.locator('.ProseMirror').getByText('There and back').waitFor();
  await until(async () => /Georgia/.test(await page.locator('.paper .ProseMirror').evaluate((el) => getComputedStyle(el).fontFamily)), 10000);
});
await step('Drive’s preview of that Word file shows it in its normal text', async () => {
  await page.goto(`${B}/drive`);
  await page.getByText('Round trip.docx', { exact: true }).first().dblclick();
  const pv = page.locator('.office-preview .tiptap');
  await pv.getByText('There and back').waitFor();
  const css = await pv.evaluate((el) => `${getComputedStyle(el).fontFamily}|${getComputedStyle(el).fontSize}`);
  if (!/Georgia/.test(css) || !css.endsWith('16px')) throw new Error(css); // 12 pt
});
await step('an .odt download keeps the page: Letter, landscape, light yellow; and comes back', async () => {
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Odt page', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wide and yellow' }] }] } })).body;
  await api(page, 'PATCH', `/files/${d.id}`, { page_setup: { size: 'letter', orientation: 'landscape', pageColor: '#fff2cc' } });
  const back = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=odt`)).arrayBuffer();
    const up = await (await fetch('/api/files/upload?name=Odt%20page.odt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    return (await fetch(`/api/files/${up.id}/open-as`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' } })).json();
  }, d.id);
  await page.goto(`${B}/docs/${back.id}`);
  await page.locator('.ProseMirror').getByText('Wide and yellow').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page setup' }).click();
  const dlg = page.getByRole('dialog', { name: 'Page setup' });
  if (!/^letter$/i.test(await dlg.getByLabel('Paper size').inputValue())) throw new Error('paper');
  if ((await dlg.getByRole('radio', { name: 'Landscape' }).getAttribute('aria-checked')) !== 'true') throw new Error('orientation');
  if ((await dlg.getByRole('radio', { name: 'Light yellow' }).getAttribute('aria-checked')) !== 'true') throw new Error('page colour');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
