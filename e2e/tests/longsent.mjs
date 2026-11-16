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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const long = 'This sentence goes on and on with one clause after another so that by the time the reader reaches the end they have quite forgotten how it started.';
const veryLong = 'Here is a sentence that keeps going far beyond what anyone could comfortably follow in one breath, adding detail upon detail, condition upon condition, and aside upon aside, until the reader simply gives up trying to hold it all in mind.';
let docId;
await step('setup: a document with short and long sentences', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content: { type: 'doc', content: [p(`Short and clear. ${long}`), p(veryLong), p('Send the the report today. The end.')] } })).body.id;
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('The end.').waitFor();
});
const marks = () => page.locator('.paper .long-sentence').allInnerTexts();
await step('Word count → Highlight long sentences marks them (very long ones more strongly) and counts them', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Word count' }).click();
  const dlg = page.getByRole('dialog', { name: 'Word count' });
  await dlg.getByLabel(/Highlight long sentences/).check();
  await dlg.getByText('2 long sentences, 1 very long: try splitting them. 1 word typed twice.').waitFor();
  if (await page.locator('.paper .repeated-word').count() !== 1) throw new Error('repeated word');
  await axe(page, 'word count with long sentences');
  await dlg.getByRole('button', { name: 'OK' }).click();
  if ((await marks()).join('|') !== `${long}|${veryLong}`) throw new Error((await marks()).join('|'));
  if (await page.locator('.paper .long-sentence.very').innerText() !== veryLong) throw new Error('very long');
  await page.screenshot({ path: `${SP}/shots/longsentences.png` });
  await axe(page, 'long sentences highlighted');
});
await step('the marks follow typing: splitting a sentence clears it; it stays on after reloading', async () => {
  await page.locator('.paper .tiptap').getByText(/by the time the reader/).click();
  const ed = page.locator('.paper .tiptap');
  // Split the first long sentence in two: put a full stop after "another".
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.paper .tiptap p')][0];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) { const i = n.data.indexOf('after another'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 'after another'.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); break; } }
  });
  await page.keyboard.type('. And');
  await ed.getByText(/one clause after another\. And so that/).waitFor();
  await until(async () => (await marks()).length === 1 && (await marks())[0] === veryLong);
  await page.getByText('All changes saved').waitFor();
  await page.reload();
  await page.getByText('The end.').waitFor();
  await until(async () => (await marks()).length === 1);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Word count' }).click();
  await page.getByRole('dialog', { name: 'Word count' }).getByLabel(/Highlight long sentences/).uncheck();
  await page.getByRole('dialog', { name: 'Word count' }).getByRole('button', { name: 'OK' }).click();
  if ((await marks()).length || await page.locator('.paper .repeated-word').count()) throw new Error('still marked');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
