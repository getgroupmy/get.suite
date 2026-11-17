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
await step('an .odt download keeps the page: Letter, landscape, light yellow, header, footer, page numbers, two columns, line numbers, watermark; and comes back', async () => {
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Odt page', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wide and yellow' }] }] } })).body;
  await api(page, 'PATCH', `/files/${d.id}`, { page_setup: { size: 'letter', orientation: 'landscape', pageColor: '#fff2cc', header: 'Acme & Co', footer: 'Private', numbers: true, columns: 2, lineNumbers: true, watermark: 'DRAFT' } });
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
  if ((await dlg.getByLabel('Header (top of every page)').inputValue()) !== 'Acme & Co') throw new Error('header');
  if ((await dlg.getByLabel('Footer (bottom of every page)').inputValue()) !== 'Private') throw new Error('footer');
  if (!(await dlg.getByLabel('Page numbers in the footer').isChecked())) throw new Error('numbers');
  if ((await dlg.getByRole('radio', { name: 'Two' }).getAttribute('aria-checked')) !== 'true') throw new Error('columns');
  if (!(await dlg.getByLabel('Line numbers in the margin').isChecked())) throw new Error('line numbers');
  if ((await dlg.getByLabel('Watermark (faint, across every page)').inputValue()) !== 'DRAFT') throw new Error('watermark');
});
await step('a quote goes out to Word and comes back as a quote', async () => {
  const p = (x) => ({ type: 'paragraph', content: [{ type: 'text', text: x }] });
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Quoted', content: { type: 'doc', content: [p('He said:'), { type: 'blockquote', content: [p('Ship it on Friday.')] }, p('So we did.')] } })).body;
  const back = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=docx`)).arrayBuffer();
    const up = await (await fetch('/api/files/upload?name=Quoted.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    return (await fetch(`/api/files/${up.id}/open-as`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' } })).json();
  }, d.id);
  await page.goto(`${B}/docs/${back.id}`);
  await page.locator('.ProseMirror blockquote', { hasText: 'Ship it on Friday.' }).waitFor();
  if (await page.locator('.ProseMirror blockquote', { hasText: 'So we did.' }).count()) throw new Error('too much in the quote');
});
await step('text in a font and size of its own goes out to Word and comes back so', async () => {
  const run = (text, attrs) => ({ type: 'text', text, marks: [{ type: 'textStyle', attrs }] });
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Fonts', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Normal, ' }, run('in Georgia', { fontFamily: 'Georgia, serif' }), { type: 'text', text: ', ' }, run('at 18 pt', { fontSize: '18pt' })] }] } })).body;
  const back = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=docx`)).arrayBuffer();
    const up = await (await fetch('/api/files/upload?name=Fonts.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    return (await fetch(`/api/files/${up.id}/open-as`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' } })).json();
  }, d.id);
  await page.goto(`${B}/docs/${back.id}`);
  const georgia = page.locator('.ProseMirror span', { hasText: 'in Georgia' });
  await georgia.waitFor();
  if (!/Georgia/.test(await georgia.evaluate((el) => getComputedStyle(el).fontFamily))) throw new Error('font');
  const big = page.locator('.ProseMirror span', { hasText: 'at 18 pt' });
  if ((await big.evaluate((el) => getComputedStyle(el).fontSize)) !== '24px') throw new Error('size'); // 18 pt
});
await step('a code block and a page break go out to Word and come back', async () => {
  const tx = (x) => ({ type: 'text', text: x }); const p = (x) => ({ type: 'paragraph', content: [tx(x)] });
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Code', content: { type: 'doc', content: [p('Setup:'), { type: 'codeBlock', content: [tx('npm install\nnpm start')] }, { type: 'pageBreak' }, p('Next page')] } })).body;
  const back = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=docx`)).arrayBuffer();
    const up = await (await fetch('/api/files/upload?name=Code.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    return (await fetch(`/api/files/${up.id}/open-as`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' } })).json();
  }, d.id);
  await page.goto(`${B}/docs/${back.id}`);
  const pre = page.locator('.ProseMirror pre');
  await pre.waitFor();
  if ((await pre.innerText()).trim() !== 'npm install\nnpm start') throw new Error(await pre.innerText());
  await page.locator('.ProseMirror [data-page-break]').waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
