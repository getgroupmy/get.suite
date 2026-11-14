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
await step('settings explain phone sync, and an app password works without email', async () => {
  await page.goto(B + '/settings');
  const sec = page.getByRole('region', { name: 'Calendar and contacts on your phone', exact: true });
  await sec.getByText(new URL(B).host, { exact: true }).waitFor();
  await sec.getByText(`${B}/dav/`, { exact: true }).waitFor();
  await sec.getByText(`${B}/dav/files/`, { exact: true }).waitFor();
  await sec.getByText(/Connect to Server/).waitFor();
  await sec.getByText(/Add CalDAV Account/).waitFor();
  await sec.getByText('your account password', { exact: true }).waitFor();
  await sec.getByRole('button', { name: 'Create mail-app password' }).click();
  await sec.getByLabel('Your account password').fill('password123');
  await sec.getByRole('button', { name: 'Create mail-app password' }).click();
  const pw = (await sec.getByLabel('Mail-app password').innerText()).trim();
  if (!/^[a-z]{4}(-[a-z]{4}){3}$/.test(pw)) throw new Error(pw);
  await page.screenshot({ path: `${SP}/shots/davsettings.png` });
  // The phone signs in with it.
  const r = await fetch(`${B}/dav/`, { method: 'PROPFIND', headers: { depth: '0', authorization: `Basic ${Buffer.from(`olivia@acme.com:${pw}`).toString('base64')}` } });
  if (r.status !== 207) throw new Error(`dav ${r.status}`);
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
