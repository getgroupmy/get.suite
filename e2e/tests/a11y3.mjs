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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const all = [];
const scan = async (name, p = page) => {
  await p.waitForTimeout(600);
  await p.addScriptTag({ content: AXE });
  const res = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, where: v.nodes.slice(0, 3).map((x) => x.target.join(' ')).join(' | '), html: v.nodes[0]?.html.slice(0, 200) })));
  for (const v of res) all.push({ page: name, ...v });
  if (res.length) throw new Error(res.map((v) => `${v.id}(${v.n})`).join(', '));
};
let kim, doc, kimId;
await step('things to look at', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Access plan' })).body;
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Access folder' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'PUT', `/files/${folder.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'Please check @kim@acme.com', anchor: { quote: 'a' }, id: 'thread-a11y-1' });
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'Fix this', anchor: { quote: 'b' }, id: 'thread-a11y-2', assign: kimId });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
await step('a11y: Home with Comments for you', async () => {
  await kim.goto(`${B}/home`);
  await kim.getByRole('region', { name: 'Comments for you' }).waitFor();
  await scan('Home comments card', kim);
});
await step('a11y: Drive with new-comment badges', async () => {
  await kim.goto(`${B}/drive/shared`);
  await kim.locator('.comment-mark').first().waitFor();
  await scan('Drive badges', kim);
});
await step('a11y: Copy to window', async () => {
  await kim.getByRole('button', { name: 'Actions for Access plan' }).click();
  await kim.getByRole('menuitem', { name: 'Copy to…' }).click();
  await kim.getByRole('dialog', { name: 'Copy “Access plan” to…' }).waitFor();
  await scan('Copy to window', kim);
  await kim.keyboard.press('Escape');
});
await step('a11y: comments panel with New, For you and editing', async () => {
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.getByRole('button', { name: /Comments/ }).first().click();
  const kp = kim.getByRole('complementary', { name: 'Comments' });
  await kp.getByText('New', { exact: true }).first().waitFor();
  await scan('Comments panel (new)', kim);
  await kp.getByRole('checkbox', { name: /^For you/ }).check({ timeout: 5000 });
  await api(kim, 'POST', `/comments/${doc.id}`, { body: 'Mine to edit', anchor: { quote: 'c' } });
  await kp.getByRole('checkbox', { name: /^For you/ }).uncheck({ timeout: 5000 });
  await kp.getByRole('button', { name: 'Edit comment by Kim Park' }).click();
  await kp.getByRole('textbox', { name: 'Edit comment' }).waitFor();
  await scan('Comments panel (editing)', kim);
});
await step('a11y: Rename several window', async () => {
  await page.goto(`${B}/drive`);
  await page.getByLabel('Select Access plan', { exact: true }).check();
  await page.getByLabel('Select Access folder', { exact: true }).check();
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('dialog').first().waitFor();
  await scan('Rename several window');
});
await step('a11y: Drive → Activity', async () => {
  await kim.goto(`${B}/drive/activity`);
  await kim.getByRole('button', { name: '“Access plan”' }).first().waitFor();
  await scan('Drive activity', kim);
});
for (const v of all) console.log(`DBG ${v.page} ${v.impact} ${v.id} x${v.n}: ${v.help} :: ${v.where} :: ${v.html}`);
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
