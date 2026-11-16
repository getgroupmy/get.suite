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
const html = (k) => page.evaluate((key) => document.documentElement.dataset[key] || null, k);
await step('Settings → Appearance: larger text grows the whole page, and stays after a reload', async () => {
  await page.goto(`${B}/settings`);
  const before = await page.getByRole('heading', { name: 'Appearance' }).boundingBox();
  await page.getByLabel('Text size').selectOption('largest');
  if (await html('textSize') !== 'largest') throw new Error('not applied');
  const after = await page.getByRole('heading', { name: 'Appearance' }).boundingBox();
  if (!(after.height > before.height * 1.15)) throw new Error(`${before.height} → ${after.height}`);
  await page.reload();
  await page.getByRole('heading', { name: 'Appearance' }).waitFor();
  if (await html('textSize') !== 'largest' || (await page.getByLabel('Text size').inputValue()) !== 'largest') throw new Error('not kept');
  await page.getByLabel('Text size').selectOption('normal');
  if (await html('textSize')) throw new Error('not back to normal');
});
await step('more contrast: darker text, underlined links, in light and dark; passes the accessibility check', async () => {
  const muted0 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());
  await page.getByRole('checkbox', { name: /More contrast/ }).check();
  if (await html('contrast') !== 'more') throw new Error('not applied');
  const muted1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());
  if (muted0 === muted1) throw new Error('muted text unchanged');
  await page.screenshot({ path: `${SP}/shots/settings-contrast.png` });
  await axe(page, 'more contrast');
  await page.reload();
  if (!(await page.getByRole('checkbox', { name: /More contrast/ }).isChecked())) throw new Error('not kept');
  await page.getByRole('checkbox', { name: /More contrast/ }).uncheck();
});
await step('a computer asking for more contrast gets it without choosing it here', async () => {
  const muted = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--muted').trim());
  await page.emulateMedia({ contrast: 'no-preference' });
  const normal = await muted();
  await page.emulateMedia({ contrast: 'more' });
  const more = await muted();
  if (normal === more || more !== '#3c4043') throw new Error(`${normal} → ${more}`);
  await axe(page, 'device contrast');
  await page.emulateMedia({ contrast: 'no-preference' });
});
await step('reduce motion: animations and transitions stop', async () => {
  await page.getByRole('checkbox', { name: /Reduce motion/ }).check();
  if (await html('motion') !== 'reduce') throw new Error('not applied');
  const d = await page.evaluate(() => getComputedStyle(document.querySelector('.btn') || document.body).transitionDuration);
  if (!/^0(\.0+1)?m?s|1e-05s/.test(d) && !d.split(',').every((x) => parseFloat(x) < 0.001)) throw new Error(d);
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
