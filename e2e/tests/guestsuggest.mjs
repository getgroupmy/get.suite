import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const style = (k, prop) => cell(k).evaluate((el, p) => getComputedStyle(el)[p], prop);
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
let sheet;

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

const until = async (fn, ms = 8000) => { for (let end = Date.now() + ms; !(await fn()); await page.waitForTimeout(150)) if (Date.now() > end) throw new Error('timed out'); };

await step('the Guests box suggests colleagues and contacts by name; a click or Enter invites them', async () => {
  if ((await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).status !== 201) throw new Error('user');
  for (const [name, email] of [['Ada Stone', 'ada@initrode.example'], ['Ben Vale', 'ben.vale@post.example']]) await api(page, 'POST', '/contacts', { name, email, company: 'Initrode Works' });
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const d = page.getByRole('dialog', { name: 'New event' });
  await d.getByLabel('Title').fill('Kick-off');
  const box = d.locator('#guest-input');
  const list = d.getByRole('listbox', { name: 'People to invite' });
  const chips = () => d.getByRole('list', { name: 'Invited guests' }).innerText();
  await box.pressSequentially('kim park'); // a name with a space in it can be typed
  await list.getByRole('option').filter({ hasText: 'Kim Park' }).getByText('Colleague').waitFor();
  await box.press('Enter');
  await until(async () => /kim/i.test(await chips()));
  if (await box.inputValue() !== '') throw new Error('the box should be empty again');
  await box.pressSequentially('ada');
  await list.getByRole('option').filter({ hasText: 'ada@initrode.example' }).click();
  await until(async () => /ada/i.test(await chips()));
  // someone already invited isn't offered again
  await box.pressSequentially('kim');
  await page.waitForTimeout(600);
  if (await list.getByRole('option').filter({ hasText: 'Kim Park' }).count()) throw new Error('Kim is already invited');
  await box.fill('');
});

await step('a company typed offers everyone there at once; Escape closes the list, not the event', async () => {
  const d = page.getByRole('dialog', { name: 'New event' });
  const box = d.locator('#guest-input');
  const list = d.getByRole('listbox', { name: 'People to invite' });
  await box.pressSequentially('initrode');
  const all = list.getByRole('option').first();
  await all.getByText('Everyone at Initrode Works').waitFor();
  await page.screenshot({ path: `${SP}/shots/guest-suggest.png` });
  await box.press('Escape');
  await list.waitFor({ state: 'detached' });
  await d.getByLabel('Title').waitFor(); // the event is still open
  await box.fill('');
  await box.pressSequentially('initrode');
  await list.getByRole('option').first().getByText('Everyone at Initrode Works').waitFor();
  await box.press('Enter');
  await until(async () => /ben/i.test(await d.getByRole('list', { name: 'Invited guests' }).innerText()));
  if ((await d.getByRole('list', { name: 'Invited guests' }).getByRole('listitem').count()) !== 3) throw new Error('Kim, Ada (once) and Ben');
  // an address typed still goes in as it always did
  await box.fill('new.person@elsewhere.example');
  await box.press('Enter');
  await until(async () => (await d.getByRole('list', { name: 'Invited guests' }).getByRole('listitem').count()) === 4);
});

await step('a To line pasted from an email goes in whole: every address, by the names written', async () => {
  const d = page.getByRole('dialog', { name: 'New event' });
  const box = d.locator('#guest-input');
  const chips = d.getByRole('list', { name: 'Invited guests' });
  const before = await chips.getByRole('listitem').count();
  await box.focus();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Otto Hahn <otto@labs.example>, "Meitner, Lise" <LISE@labs.example>; fritz@labs.example');
    document.getElementById('guest-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await until(async () => (await chips.getByRole('listitem').count()) === before + 3);
  await chips.getByRole('listitem').filter({ hasText: 'Otto Hahn' }).getByText('otto@labs.example').waitFor();
  await chips.getByRole('listitem').filter({ hasText: 'Meitner, Lise' }).getByText('lise@labs.example').waitFor();
  if (await box.inputValue() !== '') throw new Error('the box should be empty again');
  // typed the same way, ended with a comma
  await box.pressSequentially('Max Born <max@labs.example>,');
  await chips.getByRole('listitem').filter({ hasText: 'Max Born' }).waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
