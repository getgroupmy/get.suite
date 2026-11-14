import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const nodemailer = (await import('module')).createRequire(`${ROOT}/server/package.json`)('nodemailer');
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
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
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const scan = async () => {
  await page.addScriptTag({ content: AXE });
  const res = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.html.slice(0, 120)}`));
  if (res.length) throw new Error(res.join(' | '));
};
const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
const search = () => page.getByLabel('Search everything');
const tips = () => page.getByRole('group', { name: 'Tips' });
await step('in Mail, "/" is Mail\'s own search; elsewhere it is Search everything', async () => {
  await page.locator('.mail-list, main').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('/');
  try { await until(async () => (await focused()) === 'Search mail'); } catch { throw new Error(`in Mail: ${await focused()} at ${page.url()}`); }
  await page.goto(`${B}/home`);
  await search().waitFor();
  await page.locator('body').click({ position: { x: 5, y: 300 } }); // the page has the keyboard
  await page.keyboard.press('/');
  try { await until(async () => (await focused()) === 'Search everything'); } catch { throw new Error(`at home: ${await focused()}`); }
});
await step('the tips pass the accessibility checks, light and dark', async () => {
  await tips().waitFor();
  await scan();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await scan();
  await page.screenshot({ path: `${SP}/shots/search-tips-dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });
});
await step('the open box with results, recent searches and the footer passes too', async () => {
  await search().fill('budget');
  await search().press('Enter'); // remembered as a recent search (and Drive is searched)
  await page.goto(`${B}/home`);
  await search().click();
  await page.getByRole('group', { name: 'Recent searches' }).waitFor();
  await page.getByRole('button', { name: 'Clear recent searches' }).waitFor();
  await scan();
  await search().fill('bud');
  await page.getByRole('button', { name: /Search Drive for “bud”/ }).waitFor();
  await scan();
  await search().fill('');
});
await step('"doc Q3 plan" makes the document already called that', async () => {
  await search().fill('doc Q3 plan');
  const hit = page.getByRole('group', { name: 'Actions' }).getByRole('option').first();
  await until(async () => (await hit.textContent().catch(() => '')).startsWith('New document: Q3 plan'));
  await page.mouse.move(5, 700);
  await search().press('ArrowDown');
  await search().press('Enter');
  await page.waitForURL(/\/docs\//);
  const id = page.url().split('/docs/')[1].split(/[?#]/)[0];
  const f = (await api(page, 'GET', `/files/${id}`)).body;
  if ((f.file || f).name !== 'Q3 plan') throw new Error(JSON.stringify(f).slice(0, 200));
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
