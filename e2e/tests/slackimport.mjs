import JSZip from '../../server/node_modules/jszip/lib/index.js';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import { chromium } from 'playwright';
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
await step('an admin imports a Slack export; the channel, its messages and a thread are in Chat for everyone, read', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const zip = new JSZip();
  zip.file('users.json', JSON.stringify([{ id: 'U1', profile: { real_name: 'Kim Park', email: 'kim@acme.com' } }, { id: 'U2', profile: { real_name: 'Former Freelancer', email: 'free@else.com' } }]));
  zip.file('channels.json', JSON.stringify([{ name: 'design-crit', topic: { value: 'Weekly design review' } }, { name: 'random-banter' }]));
  zip.file('random-banter/2024-05-06.json', JSON.stringify([{ type: 'message', user: 'U1', text: 'Cat pictures', ts: '1714989800.0' }]));
  zip.file('design-crit/2024-05-06.json', JSON.stringify([
    { type: 'message', user: 'U1', text: 'New logo drafts are up', ts: '1714989600.000100', reactions: [{ name: 'fire', users: ['U1', 'U2'] }] },
    { type: 'message', user: 'U2', text: 'Love the second one <@U1>', ts: '1714989700.000200', thread_ts: '1714989600.000100' },
  ]));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: /Company/ }).click().catch(() => {});
  await page.getByLabel('Slack export').setInputFiles({ name: 'Acme Slack export.zip', mimeType: 'application/zip', buffer });
  const d = page.getByRole('dialog', { name: 'Import from Slack?' });
  await d.getByText('2 channels with 3 messages; 1 of 2 people who wrote in them are here (matched by email).').waitFor();
  await d.getByLabel(/#random-banter/).uncheck();
  await d.getByText('Not here, so their messages keep their Slack name: Former Freelancer.').waitFor();
  await page.screenshot({ path: `${SP}/shots/slack-preview.png` });
  if ((await api(page, 'GET', '/chat/channels')).body.channels.some((c) => c.name === 'design-crit')) throw new Error('imported before confirming');
  await d.getByRole('button', { name: 'Import 2 messages' }).click();
  await page.getByText('Imported 1 channel with 2 messages from Slack').waitFor({ timeout: 20000 });
  await page.getByRole('status').getByText(/#design-crit: 2 messages\. 1 of 2 people matched by email\. 1 reaction\. 1 left out/).waitFor();
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat`);
  const item = kim.locator('.chat-sidebar, aside').getByText('design-crit').first();
  await item.waitFor();
  await item.click();
  await kim.getByText('New logo drafts are up').waitFor();
  await kim.getByRole('button', { name: /🔥 1/ }).first().waitFor();
  await kim.screenshot({ path: `${SP}/shots/slack-import.png` });
  const chans = (await api(kim, 'GET', '/chat/channels')).body.channels;
  if (chans.some((c) => c.name === 'random-banter')) throw new Error('unticked one came in');
  const c = chans.find((x) => x.name === 'design-crit');
  if (!c || c.unread) throw new Error(`unread ${JSON.stringify(c)}`);
  const msgs = (await api(kim, 'GET', `/chat/channels/${c.id}/messages`)).body;
  const list = Array.isArray(msgs) ? msgs : msgs.messages;
  const first = list.find((m) => m.body === 'New logo drafts are up');
  if (first.user_name !== 'Kim Park') throw new Error(JSON.stringify(first));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
