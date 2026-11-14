import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
// The document's text, without other people's cursor labels (they sit inside the editor).
const text = (p) => p.evaluate(() => { const el = document.querySelector('.paper .tiptap').cloneNode(true); el.querySelectorAll('.collaboration-carets__caret').forEach((c) => c.remove()); return el.textContent; });
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let docId, kim, vic;

await step('setup: a document shared with an editor and a viewer', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const local of ['kim', 'vic']) await api(page, 'POST', '/users', { local, domain: 'acme.com', name: local === 'kim' ? 'Kim Park' : 'Vic Viewer', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: dir.find((u) => u.username === 'kim@acme.com').id, role: 'editor' }, { user_id: dir.find((u) => u.username === 'vic@acme.com').id, role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/docs/${docId}`); await p.getByText('Hello').waitFor(); }
});

await step('typing shows up for the others as you type', async () => {
  await page.locator('.paper .tiptap').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' world');
  await until(async () => (await text(kim)) === 'Hello world');
  await until(async () => (await text(vic)) === 'Hello world');
});

await step('two people typing at once end up with the same text', async () => {
  await kim.locator('.paper .tiptap').click();
  await kim.keyboard.press('Control+Home');
  await Promise.all([kim.keyboard.type('Kim: ', { delay: 30 }), (async () => { await page.keyboard.press('Control+End'); await page.keyboard.type(' and more', { delay: 30 }); })()]);
  await until(async () => (await text(page)) === 'Kim: Hello world and more' && (await text(kim)) === 'Kim: Hello world and more');
});

await step('you see who else is here and where their cursor is', async () => {
  await page.getByLabel(/^Also here: .*Kim Park/).waitFor();
  await kim.getByLabel(/^Also here: .*Olivia Owner/).waitFor();
  await page.locator('.collaboration-carets__label', { hasText: 'Kim Park' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/coedit.png` });
});

await step('it is saved', async () => {
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${docId}/content`)).body.content).includes('Kim: Hello world and more'), 10000);
  await page.getByText('All changes saved').waitFor();
});

await step('viewers watch but cannot type', async () => {
  if ((await vic.locator('.paper .tiptap').getAttribute('contenteditable')) !== 'false') throw new Error('editable for a viewer');
  await vic.getByText('View only.').waitFor();
  await until(async () => (await text(vic)) === 'Kim: Hello world and more');
});

await step('undo takes back only your own typing', async () => {
  await kim.keyboard.press('Control+End');
  await kim.keyboard.type(' (draft)');
  await until(async () => (await text(page)).endsWith('(draft)'));
  await page.keyboard.type('!');
  await until(async () => (await text(kim)).includes('more!')); // where Olivia's cursor was
  await kim.keyboard.press('Control+z');
  try { await until(async () => !(await text(page)).includes('(draft)')); } catch { throw new Error(`still: ${await text(page)} | kim: ${await text(kim)} | focus: ${await kim.evaluate(() => document.activeElement?.className)}`); }
  if ((await text(page)) !== 'Kim: Hello world and more!') throw new Error(await text(page));
}, kim);

await step('restoring a version reloads everyone onto it', async () => {
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${docId}/content`)).body.content).includes('more!'), 10000);
  const vs = (await api(page, 'GET', `/files/${docId}/versions`)).body;
  // An earlier version exists (Kim edited after Olivia); restore the oldest.
  if (!vs.length) throw new Error('no versions');
  // From another tab: the document tabs reload onto the restored version.
  const tab = await page.context().newPage();
  await tab.goto(`${B}/drive`);
  await api(tab, 'POST', `/files/${docId}/versions/${vs[vs.length - 1].id}/restore`);
  const restored = JSON.stringify((await api(tab, 'GET', `/files/${docId}/content`)).body.content);
  if (restored.includes('more!')) throw new Error('restore did not change content');
  for (const p of [page, kim]) await until(async () => { try { return !(await text(p)).includes('more!'); } catch { return false; } }, 15000);
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
