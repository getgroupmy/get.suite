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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let doc;
const kimP = () => globalThis.kim || { locator: () => ({ first: () => ({ innerText: async () => '-' }) }) };
const chip = (p, t) => p.locator('.ProseMirror .doc-cite', { hasText: t });
const refs = (p) => p.locator('.ProseMirror section.doc-refs');
const cite = async (fill) => {
  await page.getByRole('button', { name: 'Citations' }).click();
  await page.getByRole('menuitem', { name: 'Cite a source…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Cite a source' });
  await fill(dlg);
  await dlg.getByRole('button', { name: 'Insert' }).click();
  await page.waitForTimeout(300);
};
await step('❝ Cite → a new source puts (Smith, 2020) in the text', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Hybrid work report' })).body;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Most offices are hybrid ');
  await cite(async (dlg) => {
    await dlg.getByLabel('Author(s)').fill('Smith, J.');
    await dlg.getByLabel('Year').fill('2020');
    await dlg.getByLabel('Title').fill('Working from home');
    await dlg.getByLabel('Publisher or website').fill('Acme Press');
    await dlg.getByText('(Smith, 2020)').waitFor(); // the preview
  });
  await chip(page, '(Smith, 2020)').waitFor();
  await page.keyboard.type('. Teams agree ');
  await cite(async (dlg) => {
    await dlg.getByLabel('Author(s)').fill('Ng, A.; Ortiz, B.; Park, C.');
    await dlg.getByLabel('Year').fill('2019');
    await dlg.getByLabel('Title').fill('Offices');
  });
  await chip(page, '(Ng et al., 2019)').waitFor();
  await page.keyboard.type(' and again ');
  await cite(async (dlg) => { await dlg.getByLabel('A source already cited').selectOption({ label: '(Smith, 2020) Working from home' }); });
  await until(async () => (await chip(page, '(Smith, 2020)').count()) === 2);
});
await step('Insert references list: each source once, sorted, APA style; a colleague sees it live', async () => {
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Citations' }).click();
  await page.getByRole('menuitem', { name: 'Insert references list' }).click();
  await refs(page).getByText('References').waitFor();
  const lines = await refs(page).locator('.doc-ref').allInnerTexts();
  if (JSON.stringify(lines) !== JSON.stringify(['Ng, A., Ortiz, B., & Park, C. (2019). Offices.', 'Smith, J. (2020). Working from home. Acme Press.'])) throw new Error(JSON.stringify(lines));
  if ((await refs(page).locator('.doc-ref em').first().innerText()) !== 'Offices.') throw new Error('title not in italics');
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await refs(kim).locator('.doc-ref', { hasText: 'Working from home' }).waitFor();
  globalThis.kim = kim;
});
await step('clicking a citation changes it, and the references list follows', async () => {
  await chip(page, '(Ng et al., 2019)').click();
  const dlg = page.getByRole('dialog', { name: 'Change citation' });
  await dlg.getByLabel('Year').fill('2018');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await chip(page, '(Ng et al., 2018)').waitFor();
  await refs(page).locator('.doc-ref', { hasText: '(2018). Offices.' }).waitFor();
  await refs(globalThis.kim).locator('.doc-ref', { hasText: '(2018). Offices.' }).waitFor();
});
await step('the Markdown download has the citations and the references', async () => {
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Markdown (.md)' }).click()]);
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!text.includes('Most offices are hybrid (Smith, 2020). Teams agree (Ng et al., 2018) and again (Smith, 2020)')) throw new Error(JSON.stringify(text));
  if (!text.includes('**References**') || !text.includes('Smith, J. (2020). *Working from home.* Acme Press.')) throw new Error(JSON.stringify(text));
  await page.screenshot({ path: `${SP}/shots/cite.png` });
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
