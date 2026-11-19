// Drive's stars, folder colours, descriptions and labels go into Download your data (Drive details.json) and come
// back on the files and folders it brings in: a starred folder is in Starred again, with its colour.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let zip;

await step('setup: a starred, coloured folder with a labelled file, then Download your data', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api('POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const folder = (await api('POST', '/files/folder', { name: 'Contracts' })).body;
  await api('PATCH', `/files/${folder.id}`, { color: '#d93025', description: 'Signed ones only' });
  await api('PUT', `/files/${folder.id}/star`, { starred: true });
  const up = await page.request.post(`${B}/api/files/upload?name=lease.txt&parent=${folder.id}`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, data: 'the lease' });
  const f = await up.json();
  await api('PUT', `/files/${f.id || f.files?.[0]?.id}/labels`, { labels: ['Legal'] });
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.goto(`${B}/settings`); await page.getByRole('link', { name: /Download your data/ }).first().click(); })()]);
  zip = await (await import('node:fs')).promises.readFile(await dl.path());
  if (!zip.includes('Drive details.json')) throw new Error('no Drive details.json');
});

await step('Kim brings it in: Contracts is in Starred, red, and the file keeps its label', async () => {
  await ctx.clearCookies();
  await page.goto(B);
  await page.getByLabel(/Email/).first().fill('kim@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  await page.locator('.toast', { hasText: /^Brought in / }).first().waitFor({ timeout: 30000 });
  await page.goto(`${B}/drive/starred`);
  await page.getByText('Contracts', { exact: true }).first().waitFor();
  const starred = (await api('GET', '/files/starred-folders')).body;
  const c = (starred.folders || starred).find((x) => x.name === 'Contracts');
  if (!c || c.color !== '#d93025') throw new Error(JSON.stringify(starred).slice(0, 300));
  const inside = (await api('GET', `/files?parent=${c.id}`)).body;
  const lease = (inside.files || inside).find((x) => x.name === 'lease.txt');
  if (!lease || !JSON.stringify(lease.labels || []).includes('Legal')) throw new Error(JSON.stringify(lease || inside).slice(0, 300));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
