// A chat message typed after the session has already ended (the laptop left open overnight): pressing Send
// asks you to sign in, and the words are back in that conversation's box afterwards.
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
let sheet;
const signIn = async () => {
  await page.getByLabel(/Email/).first().fill('olivia@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.waitForTimeout(3000);
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

await step('a chat message typed after the session ended is still there after signing in', async () => {
  const general = (await api('GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await page.goto(`${B}/chat/${general}`);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.waitFor();
  await ctx.clearCookies(); // the session ended a while ago
  await box.fill('Morning all, typed before my coffee');
  await page.waitForTimeout(1500); // (the draft would be saved by now)
  await page.getByRole('button', { name: 'Send', exact: true }).click({ timeout: 2000 }).catch(() => {}); // (if the box is still there)
  await page.getByLabel(/Password/).first().waitFor({ timeout: 5000 });
  await signIn();
  if (!page.url().includes(`/chat/${general}`)) await page.goto(`${B}/chat/${general}`);
  await box.waitFor();
  const v = await box.inputValue().catch(() => box.innerText());
  if (!v.includes('Morning all, typed before my coffee')) throw new Error(`the box has “${v}”`);
  await page.waitForTimeout(1500);
  const saved = (await api('GET', '/chat/drafts')).body;
  if (!saved[general]?.body?.includes('typed before my coffee')) throw new Error('the kept words weren’t saved as the draft after signing in');
  const sent = (await api('GET', `/chat/channels/${general}/messages`)).body;
  if ((sent.messages || sent).some((m) => m.body === 'Morning all, typed before my coffee')) throw new Error('it was sent after all');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
