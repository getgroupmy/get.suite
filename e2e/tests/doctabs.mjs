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
const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
let id;
const ed = () => page.locator('.doc-scroll .ProseMirror');
const panel = () => page.getByRole('navigation', { name: 'Document tabs' });
await step('Add tab: the document becomes Tab 1, and a new tab opens to write in', async () => {
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The plan for spring.' }] }] };
  id = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Spring', content })).body.id;
  await page.goto(`${B}/docs/${id}`);
  await ed().getByText('The plan for spring.').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add tab' }).click();
  await panel().getByRole('button', { name: 'Tab 2', exact: true }).waitFor();
  if (await ed().getByText('The plan for spring.').isVisible()) throw new Error('Tab 1 still shows');
  await page.keyboard.type('Budget: 4,000 for the new shop.');
  await panel().getByRole('button', { name: 'Tab 1', exact: true }).click();
  await ed().getByText('The plan for spring.').waitFor({ state: 'visible' });
  if (await ed().getByText('Budget: 4,000').isVisible()) throw new Error('Tab 2 still shows');
});
await step('rename a tab; tabs stay after a reload, for everyone', async () => {
  await panel().getByRole('button', { name: 'Options for tab Tab 2' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Tab name').fill('Budget');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await panel().getByRole('button', { name: 'Budget', exact: true }).waitFor();
  await page.screenshot({ path: `${SP}/shots/doc-tabs.png` });
  await page.waitForTimeout(1500);
  await page.reload();
  await panel().getByRole('button', { name: 'Budget', exact: true }).click();
  await ed().getByText('Budget: 4,000 for the new shop.').waitFor({ state: 'visible' });
});
await step('find goes to a match in another tab, and opens it', async () => {
  await panel().getByRole('button', { name: 'Tab 1', exact: true }).click();
  await ed().getByText('The plan for spring.').waitFor({ state: 'visible' });
  await page.keyboard.press('Control+f');
  await page.getByRole('textbox', { name: /Find/ }).first().fill('4,000');
  await page.keyboard.press('Enter');
  await ed().getByText('Budget: 4,000 for the new shop.').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
});
await step('the Word download has both tabs, each under its name', async () => {
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Download as Word/ }).click()]);
  await dl.saveAs(`${SP}/tabs.docx`);
  const xml = await (await JSZip.loadAsync((await import('node:fs')).readFileSync(`${SP}/tabs.docx`))).file('word/document.xml').async('string');
  const at = ['Tab 1', 'The plan for spring.', 'Budget', 'Budget: 4,000'].map((t) => xml.indexOf(t));
  if (!at.every((x, k) => x > 0 && (k === 0 || x > at[k - 1]))) throw new Error(JSON.stringify(at));
});
await step('deleting the second tab makes it a plain document again', async () => {
  await panel().getByRole('button', { name: 'Options for tab Budget' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete tab' }).click();
  await ed().getByText('The plan for spring.').waitFor({ state: 'visible' });
  await until(async () => !(await ed().locator('section.doc-tab').count()));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
