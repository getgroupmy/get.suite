import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let dm, colleagueDm, gina, ginaId;
await step('a direct message with someone at another company, and one with a colleague', async () => {
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status >= 300) throw new Error(JSON.stringify(r));
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  gina = await mk('gina'); await signIn(gina, 'gina@globex.com');
  ginaId = (await api(gina, 'GET', '/auth/me')).body.user.id;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: ginaId })).body.id;
  colleagueDm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  if (!dm || !colleagueDm) throw new Error('no dm');
});
await step('the person outside is marked External · their company, in the list and the conversation', async () => {
  await page.goto(`${B}/chat/${dm}`);
  await page.getByRole('note').getByText(/Gina Globex works at Globex Shipping, outside Acme Trading/).waitFor();
  await page.getByLabel('External, at Globex Shipping').first().waitFor();
  if (await page.getByLabel(/^External, at/).count() !== 1) throw new Error('only Gina is external');
  await page.screenshot({ path: `${SP}/shots/chat-external.png` });
  await axe(page, 'chat external');
  await page.goto(`${B}/chat/${colleagueDm}`);
  await page.getByRole('textbox', { name: 'Message' }).waitFor();
  if (await page.getByText(/works at .*, outside/).count()) throw new Error('marked a colleague');
});
await step('their messages carry the External tag beside their name; ours don’t', async () => {
  await api(gina, 'POST', `/chat/channels/${dm}/messages`, { body: 'Hello from Globex' });
  await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'Hi Gina' });
  await page.goto(`${B}/chat/${dm}`);
  const theirs = page.locator('.msg', { hasText: 'Hello from Globex' });
  await theirs.getByText('External · Globex Shipping').waitFor();
  const ours = page.locator('.msg', { hasText: 'Hi Gina' });
  await ours.waitFor();
  if (await ours.getByText(/External/).count()) throw new Error('tagged our own message');
  await axe(page, 'external tag on messages');
});
await step('a link from outside to a lookalike of the company’s site is warned about; the same from a colleague isn’t', async () => {
  await api(gina, 'POST', `/chat/channels/${dm}/messages`, { body: 'Please reset it at https://acme-login.com/reset today' });
  await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'Our own page: https://www.acme.com/help' });
  await page.goto(`${B}/chat/${dm}`);
  const theirs = page.locator('.msg', { hasText: 'Please reset it at' });
  await theirs.getByRole('note').getByText(/acme-login\.com is made to look like acme\.com, but it isn’t/).waitFor();
  if (await page.locator('.msg', { hasText: 'Our own page' }).getByRole('note').count()) throw new Error('warned about our own link');
  await page.screenshot({ path: `${SP}/shots/chat-lookalike.png` });
  await axe(page, 'chat lookalike link');
});
await step('Report as suspicious on a message from outside (not on ours): it reaches Admin → Phishing, with no email set up', async () => {
  await page.goto(`${B}/chat/${dm}`);
  const ours = page.locator('.msg', { hasText: 'Hi Gina' });
  await ours.hover();
  if (await ours.getByRole('button', { name: 'Report as suspicious' }).count()) throw new Error('offered on our own message');
  const theirs = page.locator('.msg', { hasText: 'Please reset it at' });
  await theirs.hover();
  await theirs.getByRole('button', { name: 'Report as suspicious' }).click();
  const dlg = page.getByRole('dialog', { name: 'Report this message as suspicious?' });
  await dlg.getByText(/admins are told about Gina Globex/).waitFor();
  await axe(page, 'report dialog');
  await dlg.getByRole('button', { name: 'Report' }).click();
  await page.getByText('Reported: your admins have been told').waitFor();
  await page.goto(`${B}/admin?tab=phishing`);
  const row = page.getByRole('row', { name: /gina@globex\.com/ });
  await row.getByText(/Chat: Please reset it at/).waitFor();
  if (await row.getByRole('button', { name: /Block sender|Remove from inboxes/ }).count()) throw new Error('email actions without email');
  await page.getByRole('button', { name: 'Warn everyone about gina@globex.com' }).click();
  const text = await page.getByRole('dialog').getByRole('textbox').inputValue();
  if (!/chat messages from gina@globex\.com/.test(text)) throw new Error(text);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${SP}/shots/chat-reported.png` });
  await axe(page, 'phishing tab without email');
});
await step('a comment on a shared document by someone at another company: External · their company beside their name', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Joint plan', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shipping schedule draft' }] }] } })).body;
  const sh = await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: ginaId, role: 'editor' }] });
  if (sh.status >= 300) throw new Error(JSON.stringify(sh));
  const c1 = await api(gina, 'POST', `/comments/${doc.id}`, { body: 'Can we ship on Friday?', anchor: { quote: 'Shipping' } });
  if (c1.status >= 300) throw new Error(JSON.stringify(c1));
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'Friday works', anchor: { quote: 'schedule' } });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: /Comments/ }).first().click();
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await panel.locator('.comment-meta', { hasText: 'Gina Globex' }).getByText('External · Globex Shipping').waitFor();
  if (await panel.locator('.comment-meta', { hasText: 'Olivia Owner' }).getByText(/External/).count()) throw new Error('tagged our own comment');
  await axe(page, 'external comment');
});
await step('Drive: a file from someone at another company says External · their company by the owner, in the list and its details', async () => {
  await gina.goto(`${B}/drive/shared`);
  const row = gina.getByRole('row', { name: /Joint plan/ });
  await row.getByText('External · Acme Trading').waitFor();
  await axe(gina, 'drive shared external');
  await gina.screenshot({ path: `${SP}/shots/drive-external.png` });
  await row.getByRole('button', { name: 'Actions for Joint plan' }).click();
  await gina.getByRole('menuitem', { name: /Details/ }).click();
  await gina.getByRole('dialog', { name: 'Details' }).getByText('External · Acme Trading').waitFor();
  await gina.keyboard.press('Escape');
  await page.goto(`${B}/drive`);
  await page.getByRole('row', { name: /Joint plan/ }).waitFor();
  if (await page.getByText(/External · /).count()) throw new Error('tagged our own file');
}, gina);
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
