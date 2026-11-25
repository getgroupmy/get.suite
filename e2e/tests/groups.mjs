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
let doc, kim;
await step('people and a document', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Campaign plan' })).body;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
await step('admin makes a group and picks its members', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  await page.getByLabel('Group name').fill('Marketing');
  await page.getByRole('button', { name: 'Create group' }).click();
  const g = page.getByRole('listitem', { name: 'Group Marketing' });
  const ppl = g.getByRole('list', { name: 'People in Marketing' });
  await ppl.getByLabel(/Kim Park/).check();
  await until(async () => (await api(page, 'GET', '/groups')).body[0]?.members.length === 1);
  await g.getByText('1 person').waitFor();
});
await step('share the document with the group', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'Share' }).click();
  const d = page.getByRole('dialog', { name: /Share/ });
  await d.getByLabel('Access', { exact: true }).selectOption('editor');
  await d.getByLabel('Share with a group').selectOption({ label: 'Marketing (1)' });
  await d.getByLabel('Access for the group Marketing').waitFor();
  await d.getByLabel('Message to the group Marketing (optional)').fill('Edit the launch section, please');
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await until(async () => (await api(kim, 'GET', `/files/${doc.id}`)).body?.role === 'editor');
});
await step('the member sees it in Shared with me, with a notification', async () => {
  await kim.goto(`${B}/drive/shared`);
  await kim.getByText('Campaign plan').first().waitFor();
  await kim.getByRole('button', { name: /Notifications, \d+ new/ }).click();
  await kim.getByText('shared “Campaign plan” with the group Marketing').waitFor();
  await kim.getByText('“Edit the launch section, please”').waitFor();
});
await step('Share window lists the group; people list stays separate', async () => {
  await page.getByRole('button', { name: 'Share' }).click();
  const d = page.getByRole('dialog', { name: /Share/ });
  if ((await d.getByLabel('Access for the group Marketing').inputValue()) !== 'editor') throw new Error('role');
  if (await d.getByLabel('Access for Kim Park').count()) throw new Error('Kim listed as a person');
  await d.getByRole('button', { name: 'Cancel' }).click();
});
await step('taking someone off the group takes access away', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  const g = page.getByRole('listitem', { name: 'Group Marketing' });
  await g.getByRole('button', { name: 'Members' }).click();
  await g.getByRole('list', { name: 'People in Marketing' }).getByLabel(/Kim Park/).uncheck();
  await until(async () => (await api(kim, 'GET', `/files/${doc.id}`)).status === 404);
  await g.getByRole('list', { name: 'People in Marketing' }).getByLabel(/Lee Chan/).check();
  await g.getByText('1 person').waitFor();
});
await step('deleting the group', async () => {
  await page.getByRole('button', { name: 'Delete group Marketing' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByText('No groups yet.').waitFor();
});
await step('Kim taken out of a group that edits a document she added a picture to: it still shows there', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  const g = (await api(page, 'POST', '/groups', { name: 'Designers' })).body;
  await api(page, 'PUT', `/groups/${g.id}/members`, { user_ids: [kimId] });
  const book = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Brand book' })).body;
  await api(page, 'PUT', `/files/${book.id}/groups`, { groups: [{ group_id: g.id, role: 'editor' }] });
  const pic = await kim.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 44; c.height = 22; const x = c.getContext('2d'); x.fillStyle = '#c0ca33'; x.fillRect(0, 0, 44, 22);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    return (await fetch('/api/files/upload?name=lime.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: blob })).json();
  });
  const cur = (await api(kim, 'GET', `/files/${book.id}/content`)).body;
  await api(kim, 'PUT', `/files/${book.id}/content`, { version: cur.file.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Our colours' }] }, { type: 'image', attrs: { fileId: pic.id, alt: 'Lime swatch' } }] } });
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  const item = page.getByRole('listitem', { name: 'Group Designers' });
  await item.getByRole('button', { name: 'Members' }).click();
  await item.getByRole('list', { name: 'People in Designers' }).getByRole('checkbox', { name: /Kim Park/ }).uncheck();
  await until(async () => (await api(page, 'GET', `/files/${book.id}/content`)).body.content.content[1].attrs.fileId !== pic.id);
  await page.goto(`${B}/docs/${book.id}`);
  await page.locator('.ProseMirror').getByText('Our colours').waitFor();
  await until(() => page.locator('.ProseMirror img[alt="Lime swatch"]').evaluate((i) => i.complete && i.naturalWidth === 44).catch(() => false), 10000);
});
await step('Export as CSV: every group and who is in it', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export as CSV' }).click()]);
  if (dl.suggestedFilename() !== 'groups.csv') throw new Error(dl.suggestedFilename());
  const fs = await import('node:fs');
  const lines = fs.readFileSync(await dl.path(), 'utf8').replace(/^\ufeff/, '').trim().split(/\r\n/);
  const groups = (await api(page, 'GET', '/groups')).body;
  const want = groups.flatMap((g) => (g.members.length ? g.members.map((m) => `${g.name},${g.description || ''},${g.email || ''},${m.name},${m.username}`) : [`${g.name},${g.description || ''},${g.email || ''},,`]));
  if (!groups.length || lines[0] !== 'Group,Description,Group email,Member,Member email' || lines.slice(1).join('|') !== want.join('|')) throw new Error(`${lines.join(' | ')} vs ${want.join(' | ')}`);
});
await step('Import from CSV: groups made and people added, unknown addresses said', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  const fs = await import('node:fs');
  const file = `${SP}/groups-in.csv`;
  fs.writeFileSync(file, 'Group,Description,Member email\r\nField team,Out and about,kim@acme.com\r\nField team,,lee@acme.com\r\nField team,,ghost@else.org\r\n');
  await page.getByLabel('Groups file to import').setInputFiles(file);
  await page.locator('.toast', { hasText: '1 group made, 2 people added; not in the company: ghost@else.org' }).waitFor();
  const g = page.getByRole('listitem', { name: 'Group Field team' });
  await g.getByText('2 people').waitFor();
  await g.getByText('Kim Park, Lee Chan').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
