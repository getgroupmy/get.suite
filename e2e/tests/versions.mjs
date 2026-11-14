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
const upload = (p, name, text) => p.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: t })).json(), [name, text]);
const raw = (p, id) => p.evaluate(async (i) => (await fetch(`/api/files/${i}/raw`)).text(), id);
let file;

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
  file = await upload(page, 'quote.txt', 'Quote, first draft');
});

await step('upload a new version from the menu', async () => {
  await page.goto(B + '/drive');
  await page.getByLabel('Actions for quote.txt').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Upload new version' }).click()]);
  await chooser.setFiles({ name: 'quote-v2.txt', mimeType: 'text/plain', buffer: Buffer.from('Quote, second draft with prices') });
  await page.getByText('New version of quote.txt uploaded').waitFor();
  if ((await raw(page, file.id)) !== 'Quote, second draft with prices') throw new Error('not replaced');
  await page.getByRole('cell', { name: 'quote-v2.txt', exact: true }).waitFor(); // takes the new name
});

await step('history lists the earlier version; download it', async () => {
  await page.getByLabel('Actions for quote-v2.txt').click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  const dlg = page.getByRole('dialog', { name: 'Version history: quote-v2.txt' });
  await dlg.getByText('Current version').waitFor();
  const items = dlg.getByRole('list', { name: 'Versions' }).getByRole('listitem');
  await items.nth(1).getByText(/Olivia Owner · 18 B · named “quote.txt”/).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), items.nth(1).getByRole('link', { name: /^Download the version/ }).click()]);
  if (dl.suggestedFilename() !== 'quote.txt') throw new Error(dl.suggestedFilename());
  await page.screenshot({ path: `${SP}/shots/versions-dialog.png` });
});

await step('restore it; the replaced one stays in the history', async () => {
  const dlg = page.getByRole('dialog', { name: 'Version history: quote-v2.txt' });
  await dlg.getByRole('button', { name: /^Restore the version/ }).click();
  await page.getByRole('dialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
  await page.getByText(/^Restored the version from /).waitFor();
  if ((await raw(page, file.id)) !== 'Quote, first draft') throw new Error('not restored');
  await page.getByRole('dialog', { name: /^Version history/ }).getByRole('list', { name: 'Versions' }).getByRole('listitem').nth(2).waitFor();
  const n = await page.getByRole('dialog', { name: /^Version history/ }).getByRole('list', { name: 'Versions' }).getByRole('listitem').count();
  if (n !== 3) throw new Error(`${n} rows`);
});

await step('delete a version', async () => {
  const dlg = page.getByRole('dialog', { name: /^Version history/ });
  await dlg.getByRole('button', { name: /^Delete the version/ }).first().click();
  await page.getByRole('dialog', { name: 'Delete this version?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Version deleted').waitFor();
  await page.waitForTimeout(300);
  const n = await page.getByRole('dialog', { name: /^Version history/ }).getByRole('list', { name: 'Versions' }).getByRole('listitem').count();
  if (n !== 2) throw new Error(`${n} rows`);
  await page.keyboard.press('Escape');
});

await step('documents: restore an earlier session, and an open editor picks it up', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Proposal' })).body;
  const body = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
  let v = (await api(page, 'PUT', `/files/${doc.id}/content`, { version: 1, content: body('Original wording') })).body.version;
  // A later session (we pretend 11 minutes passed by asking the server's own test hook: just edit as a colleague).
  await api(page, 'POST', '/users', { local: 'cara', domain: 'acme.com', name: 'Cara Colleague', password: 'password123' });
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  const cara = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'cara@acme.com');
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: cara.id, role: 'editor' }] });
  const ctx = await browser.newContext(); const cp = await ctx.newPage();
  await cp.goto(B);
  await cp.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cara@acme.com', password: 'password123' }) }));
  v = (await api(cp, 'PUT', `/files/${doc.id}/content`, { version: v, content: body('Cara rewrote everything') })).body.version;
  await ctx.close();
  if (!me) throw new Error('no me');
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByText('Cara rewrote everything').waitFor();
  // Restore from Drive in another tab; this editor loads it.
  const other = await page.context().newPage();
  await other.goto(B + '/drive/shared'); await other.goto(B + '/drive');
  await other.getByLabel('Actions for Proposal').click();
  await other.getByRole('menuitem', { name: 'Version history' }).click();
  await other.getByRole('dialog', { name: 'Version history: Proposal' }).getByRole('button', { name: /^Restore the version/ }).click();
  await other.getByRole('dialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
  await other.getByText(/^Restored the version from /).waitFor();
  await page.getByText('Original wording').waitFor({ timeout: 10000 });
  await other.close();
});

await step('viewers see the history but cannot restore', async () => {
  const f = await upload(page, 'terms.txt', 'v1');
  await page.evaluate(async (id) => fetch(`/api/files/${id}/versions`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: 'v2' }), f.id);
  const cara = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'cara@acme.com');
  await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: cara.id, role: 'viewer' }] });
  const ctx = await browser.newContext(); const cp = await ctx.newPage();
  await cp.goto(B);
  await cp.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cara@acme.com', password: 'password123' }) }));
  await cp.goto(B + '/drive/shared');
  await cp.getByLabel('Actions for terms.txt').click();
  if (await cp.getByRole('menuitem', { name: 'Upload new version' }).count()) throw new Error('viewer can upload');
  await cp.getByRole('menuitem', { name: 'Version history' }).click();
  const dlg = cp.getByRole('dialog', { name: 'Version history: terms.txt' });
  await dlg.getByRole('link', { name: /^Download the version/ }).waitFor();
  if (await dlg.getByRole('button', { name: /^Restore/ }).count()) throw new Error('viewer can restore');
  await ctx.close();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
