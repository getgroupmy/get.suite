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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
const upload = async (...files) => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), (async () => { await page.getByRole('button', { name: 'New' }).click(); await page.getByRole('menuitem', { name: /File upload|Upload files/ }).click(); })()]);
  await fc.setFiles(files.map(([name, text]) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })));
};
const mine = async () => (await api(page, 'GET', '/files')).body.filter((f) => f.kind === 'file');
const raw = (id) => page.evaluate(async (i) => (await fetch(`/api/files/${i}/raw`)).text(), id);
await step('first upload: no question', async () => {
  await page.goto(`${B}/drive`);
  await upload(['report.txt', 'version one']);
  await page.getByRole('row', { name: /report\.txt/ }).waitFor();
  if (await page.getByRole('dialog').count()) throw new Error('asked about a new name');
});
await step('the same name again: asked; Replace makes a new version, the old one in history', async () => {
  const before = (await mine()).find((f) => f.name === 'report.txt');
  await upload(['report.txt', 'version two']);
  const dlg = page.getByRole('dialog', { name: '“report.txt” is already in this folder' });
  await dlg.getByText(/the old one is kept in version history/).waitFor();
  await axe(page, 'upload clash');
  await page.screenshot({ path: `${SP}/shots/upload-clash.png` });
  await dlg.getByRole('button', { name: 'Replace' }).click();
  await page.getByText(/1 file replaced with a new version/).waitFor();
  const files = await mine();
  if (files.length !== 1 || files[0].name !== 'report.txt') throw new Error(JSON.stringify(files.map((f) => f.name)));
  if (files[0].id !== before.id || await raw(before.id) !== 'version two') throw new Error('not replaced in place');
  const versions = (await api(page, 'GET', `/files/${before.id}/versions`)).body;
  if (!JSON.stringify(versions).length || (Array.isArray(versions) ? versions : versions.versions || []).length < 1) throw new Error(JSON.stringify(versions));
});
await step('Keep both adds a numbered copy; Cancel uploads nothing', async () => {
  await upload(['report.txt', 'version three']);
  await page.getByRole('dialog').getByRole('button', { name: 'Keep both' }).click();
  await page.getByRole('row', { name: /report \(1\)\.txt/ }).waitFor();
  await upload(['report.txt', 'version four']);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(600);
  const names = (await mine()).map((f) => f.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['report (1).txt', 'report.txt'])) throw new Error(JSON.stringify(names));
});
await step('several at once, some new: Skip these uploads only the new ones', async () => {
  await upload(['report.txt', 'x'], ['fresh.txt', 'new']);
  const dlg = page.getByRole('dialog', { name: '“report.txt” is already in this folder' });
  await dlg.getByRole('button', { name: 'Skip these' }).click();
  await page.getByRole('row', { name: /fresh\.txt/ }).waitFor();
  const r = (await mine()).find((f) => f.name === 'report.txt');
  if (await raw(r.id) !== 'version two') throw new Error('a skipped one was uploaded');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
