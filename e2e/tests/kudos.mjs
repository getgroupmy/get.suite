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
const kim = await mk('kim');
await step('setup: a colleague', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/`);
});
await step('Directory → a colleague’s card → Say thanks: an emoji and a few words', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Directory' }).click();
  await page.getByRole('button', { name: 'Kim Park', exact: true }).click();
  const card = page.getByRole('dialog', { name: 'Kim Park' });
  await card.getByRole('button', { name: '🙌 Say thanks' }).click();
  const form = card.getByRole('form', { name: 'Thank Kim Park' });
  await form.getByRole('radio', { name: '🚀' }).click();
  await form.getByLabel('What for').fill('Thanks for covering the launch call');
  await page.screenshot({ path: `${SP}/shots/kudos-form.png` });
  await form.getByRole('button', { name: 'Send thanks' }).click();
  await page.getByText('🚀 Thanks sent to Kim Park').last().waitFor();
  const got = card.getByRole('list', { name: 'Thanks received' });
  await got.getByText('Thanks for covering the launch call').waitFor();
  await card.getByText('Thanks received (1)').waitFor();
});
await step('Kim is told in the bell, and sees it on Home (live) and on her own card (without Say thanks)', async () => {
  await kim.getByRole('button', { name: /Notifications/ }).first().click();
  await kim.getByText('🚀 Olivia Owner thanked you').first().waitFor({ timeout: 10000 });
  await kim.getByText('🚀 Olivia Owner thanked you').first().click(); // opens Home
  await kim.waitForURL(/\/home/);
  const home = kim.getByRole('region', { name: 'Thanks' });
  await home.getByText(/thanked/).first().waitFor({ timeout: 10000 });
  await home.getByText('Thanks for covering the launch call').waitFor();
  await kim.screenshot({ path: `${SP}/shots/kudos-home.png` });
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('tab', { name: 'Directory' }).click();
  await kim.getByRole('button', { name: 'Kim Park', exact: true }).click();
  const card = kim.getByRole('dialog', { name: 'Kim Park' });
  await card.getByText('Thanks received (1)').waitFor();
  if (await card.getByRole('button', { name: '🙌 Say thanks' }).count()) throw new Error('thanking yourself is offered');
  if (await card.getByRole('button', { name: 'Take back your thanks' }).count()) throw new Error('Kim can take back Olivia’s thanks');
}, kim);
await step('👏 Kim joins in from Home; Olivia sees the count on the card, live, and can’t clap her own', async () => {
  await kim.goto(`${B}/home`);
  const home = kim.getByRole('region', { name: 'Thanks' });
  const clap = home.getByRole('button', { name: /^👏 Applaud: 0 people/ });
  await clap.waitFor({ timeout: 10000 });
  await clap.click();
  await home.getByRole('button', { name: /^👏 Applauding: 1 person \(Kim Park\)/ }).waitFor();
  await kim.reload();
  await home.getByRole('button', { name: /^👏 Applauding: 1 person/ }).waitFor({ timeout: 10000 });
  const card = page.getByRole('dialog', { name: 'Kim Park' });
  await card.locator('span.kudos-clap', { hasText: '👏 1' }).waitFor({ timeout: 10000 }); // live
  if (await card.getByRole('button', { name: /Applaud/ }).count()) throw new Error('Olivia can clap her own');
  await page.screenshot({ path: `${SP}/shots/kudos-clap.png` });
  await home.getByRole('button', { name: /^👏 Applauding/ }).click();
  await home.getByRole('button', { name: /^👏 Applaud: 0 people/ }).waitFor();
  await card.locator('span.kudos-clap').waitFor({ state: 'detached', timeout: 10000 });
  await home.getByRole('button', { name: /^👏 Applaud/ }).click(); // on again, for the next step
  await card.locator('span.kudos-clap', { hasText: '👏 1' }).waitFor({ timeout: 10000 });
}, kim);
await step('the giver takes it back: gone from the card and Home', async () => {
  const card = page.getByRole('dialog', { name: 'Kim Park' });
  await card.getByRole('button', { name: 'Take back your thanks' }).click();
  await page.getByText('Thanks taken back').last().waitFor();
  await card.getByText(/Thanks received/).waitFor({ state: 'detached' });
  await kim.goto(`${B}/home`);
  await kim.getByRole('link', { name: 'Home', exact: true }).first().waitFor();
  await kim.waitForTimeout(1500);
  if (await kim.getByRole('region', { name: 'Thanks' }).count()) throw new Error('still on Home');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
