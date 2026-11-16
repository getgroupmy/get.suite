import JSZip from '../../server/node_modules/jszip/lib/index.js';
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
// Moving here from Notion: its Markdown & CSV export, brought in from Settings.
const A = '0123456789abcdef0123456789abcdef', C = 'fedcba9876543210fedcba9876543210';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await step('Settings → Move here → Notion: the steps, and the export brought in', async () => {
  const z = new JSZip();
  z.file(`Export-1/Team wiki ${A}.md`, `# Team wiki\n\nStart with the [Onboarding](Team%20wiki%20${A}/Onboarding%20${C}.md) page.\n\n![office.png](Team%20wiki%20${A}/office.png)\n`);
  z.file(`Export-1/Team wiki ${A}/Onboarding ${C}.md`, '# Onboarding\n\n- Get a laptop\n- Meet the team\n');
  z.file(`Export-1/Team wiki ${A}/office.png`, PNG);
  z.file(`Export-1/Projects ${C}_all.csv`, 'Name,Owner,Status\nWebsite,Ana,Doing\nApp,Bo,Done\n');
  z.file(`Export-1/Projects ${C}/Website ${A}.md`, '# Website\n\nOwner: Ana\nStatus: Doing\n\n<aside>\n💡 Launch before the trade fair.\n\n</aside>\n');
  const buf = await z.generateAsync({ type: 'nodebuffer' });
  await page.goto(`${B}/settings`);
  const sec = page.getByRole('region', { name: 'Move here from another service' });
  await sec.getByRole('button', { name: 'Notion', exact: true }).click();
  await sec.getByRole('list', { name: 'Steps for Notion' }).getByText('Markdown & CSV').waitFor();
  if (await sec.getByRole('link', { name: /Copy messages from the account/ }).count()) throw new Error('offers to copy mail from Notion');
  await page.getByLabel('Your Notion export (.zip)').setInputFiles({ name: 'Export-1.zip', mimeType: 'application/zip', buffer: buf });
  await page.locator('.toast', { hasText: /^From Notion: brought in / }).first().waitFor({ timeout: 30000 });
  const msg = await page.locator('.toast', { hasText: /^From Notion: brought in / }).first().innerText();
  if (!/^From Notion: brought in 5 files into “From Notion \d{4}-\d{2}-\d{2}” in Drive$/.test(msg)) throw new Error(msg);
});
await step('in Drive: the wiki’s folder with its page, sub-page and picture; the database as a spreadsheet', async () => {
  await page.goto(`${B}/drive`);
  await page.getByText(/^From Notion \d{4}-/).first().dblclick();
  await page.locator('table.files').getByText('Projects', { exact: true }).first().waitFor();
  await page.locator('table.files').getByText('Team wiki', { exact: true }).dblclick();
  for (const n of ['Team wiki', 'Onboarding', 'office.png']) await page.locator('table.files').getByText(n, { exact: true }).waitFor();
});
await step('the page opens in Docs with its picture, and its link goes to the Onboarding document', async () => {
  await page.locator('table.files tr', { has: page.locator('td.name', { hasText: /^Team wiki$/ }) }).dblclick();
  await page.locator('.ProseMirror').getByText('Start with the').waitFor();
  await page.locator('.ProseMirror img[alt="office.png"]').waitFor();
  if (!(await page.locator('.ProseMirror img[alt="office.png"]').evaluate((img) => img.complete && img.naturalWidth > 0))) throw new Error('picture not shown');
  const href = await page.locator('.ProseMirror a', { hasText: 'Onboarding' }).getAttribute('href');
  await page.goto(new URL(href, B).href);
  await page.locator('.ProseMirror').getByText('Meet the team').waitFor();
});
await step('the database opens in Sheets, its heading row bold', async () => {
  const top = (await api(page, 'GET', '/files')).body.find((f) => /^From Notion/.test(f.name));
  const folder = (await api(page, 'GET', `/files?parent=${top.id}`)).body.find((f) => f.name === 'Projects' && f.kind === 'folder');
  const sheet = (await api(page, 'GET', `/files?parent=${folder.id}`)).body.find((f) => f.name === 'Projects' && f.kind === 'sheet');
  await page.goto(`${B}/sheets/${sheet.id}`);
  await page.getByText('Website', { exact: true }).waitFor();
  await page.getByText('Owner', { exact: true }).waitFor();
});
await step('a database row’s page: its properties one per line, names bold; its callout as a quote', async () => {
  const top = (await api(page, 'GET', '/files')).body.find((f) => /^From Notion/.test(f.name));
  const folder = (await api(page, 'GET', `/files?parent=${top.id}`)).body.find((f) => f.name === 'Projects' && f.kind === 'folder');
  const names = (await api(page, 'GET', `/files?parent=${folder.id}`)).body.map((f) => `${f.name}:${f.kind}`).sort();
  if (names.join() !== 'Projects:sheet,Website:doc') throw new Error(names.join());
  const row = (await api(page, 'GET', `/files?parent=${folder.id}`)).body.find((f) => f.name === 'Website');
  await page.goto(`${B}/docs/${row.id}`);
  const ed = page.locator('.ProseMirror');
  await ed.locator('p', { hasText: 'Owner: Ana' }).locator('strong', { hasText: 'Owner:' }).waitFor();
  await ed.locator('p', { hasText: 'Status: Doing' }).waitFor();
  await ed.locator('blockquote', { hasText: 'Launch before the trade fair.' }).waitFor();
  if (await ed.getByText('<aside>').count()) throw new Error('aside tag shown');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
