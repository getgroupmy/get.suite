import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
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
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
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
const wrap = () => page.locator('.compose-editor .tiptap .img-wrap');
const width = async () => Number((await wrap().getAttribute('data-width')) || 100);
// Shown share of the message width, measured on screen.
const shown = () => page.evaluate(() => {
  const w = document.querySelector('.compose-editor .tiptap .img-wrap');
  const ed = document.querySelector('.compose-editor .tiptap');
  const cs = getComputedStyle(ed);
  return Math.round((w.getBoundingClientRect().width / (ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))) * 100);
});
const dragTo = async (pct) => {
  const h = await page.locator('.img-handle').boundingBox();
  const ed = await page.evaluate(() => {
    const e = document.querySelector('.compose-editor .tiptap');
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { left: r.left + parseFloat(cs.paddingLeft), width: e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
  });
  const startX = h.x + h.width / 2, y = h.y + h.height / 2;
  const handleOffset = startX - (await wrap().boundingBox()).x - (await wrap().boundingBox()).width;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(ed.left + (ed.width * pct) / 100 + handleOffset - 20, y, { steps: 5 });
  await page.locator('.img-size-label').waitFor(); // live label while dragging
  await page.mouse.move(ed.left + (ed.width * pct) / 100 + handleOffset, y, { steps: 5 });
  await page.mouse.up();
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
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});



const gina = await mk('gina');
await step('gina-sends-coloured-text', async () => {
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.getByRole('link', { name: 'Mail' }).click();
  const html = '<p style="font-family: Georgia, serif">Dear team,</p><p>Project status: <span style="color:#cc0000">Delayed</span>, budget <font color="green">on track</font>.</p>'
    + '<blockquote style="margin:0 0 0 40px;border:none;padding:0px"><div>Indented note</div></blockquote>'
    + '<p style="font-size:10px">Sent from the Globex office</p>'
    + '<div style="background:#000; color:#ffffff">Footer text</div>';
  const r = await api(gina, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Status colours', text: 'Project status', html });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
}, gina);

const ed = () => page.locator('.compose-editor .tiptap');
const colorOf = (loc) => loc.evaluate((el) => el.style.color);
await step('reply-keeps-the-colours', async () => {
  const row = page.locator('.msg-list li', { hasText: 'Status colours' });
  await refreshUntil(page, row);
  await row.locator('.msg-row').click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  const late = ed().locator('blockquote span', { hasText: 'Delayed' });
  await late.waitFor();
  if ((await colorOf(late)) !== 'rgb(204, 0, 0)') throw new Error('red: ' + await colorOf(late));
  if ((await colorOf(ed().locator('blockquote span', { hasText: 'on track' }))) !== 'rgb(0, 128, 0)') throw new Error('green lost');
  if (await ed().locator('span', { hasText: 'Footer text' }).count()) throw new Error('white text should lose its colour');
  if (!/Footer text/.test(await ed().innerText())) throw new Error('footer text missing');
  // Gmail-style indent arrives as an indent, not as another quote.
  const note = ed().locator('blockquote p', { hasText: 'Indented note' });
  if ((await note.getAttribute('data-indent')) !== '1' || (await ed().locator('blockquote blockquote').count())) throw new Error('indent not kept');
  // Fonts and sizes come along too; the size menu names the quoted size.
  const dear = ed().locator('blockquote span', { hasText: 'Dear team' });
  if (!/Georgia/.test(await dear.evaluate((el) => el.style.fontFamily))) throw new Error('font lost');
  const fine = ed().locator('blockquote span', { hasText: 'Sent from the Globex office' });
  if ((await fine.evaluate((el) => el.style.fontSize)) !== '12px') throw new Error('size ' + await fine.evaluate((el) => el.style.fontSize));
  await page.evaluate(() => { const e = document.querySelector('.tiptap').editor; let at = 0; e.state.doc.descendants((n, pos) => { if (!at && n.isText && n.text.includes('Globex office')) at = pos + 2; }); e.chain().focus().setTextSelection(at).run(); });
  await page.waitForFunction(() => document.querySelector('[aria-label="Font size"]').value === 'Small');
  await page.evaluate(() => { const e = document.querySelector('.tiptap').editor; let at = 0; e.state.doc.descendants((n, pos) => { if (!at && n.isText && n.text.includes('Dear team')) at = pos + 2; }); e.chain().focus().setTextSelection(at).run(); });
  await page.waitForFunction(() => document.querySelector('[aria-label="Font"]').value === 'Georgia'); // the quoted font, by name
});

await step('clear-formatting-removes-a-colour', async () => {
  const green = ed().locator('blockquote span', { hasText: 'on track' });
  await green.dblclick(); // select "on"
  await green.click({ clickCount: 3 }); // the whole paragraph
  await page.getByRole('button', { name: 'More formatting', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clear formatting' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.compose-editor .tiptap span')].some((s) => s.textContent.includes('on track')), null, { timeout: 5000 });
  // Undo it again: the colours go to the recipient.
  await page.keyboard.press('Control+z');
  await ed().locator('blockquote span', { hasText: 'on track' }).waitFor();
});

await step('recipient-sees-the-colours', async () => {
  await page.waitForTimeout(300);
  await page.locator('.compose-editor .tiptap > p').first().click();
  await page.waitForFunction(() => document.querySelector('.tiptap').editor.state.selection.empty);
  await page.keyboard.type('Thanks, noted.');
  if (!/Project status/.test(await ed().locator('blockquote').innerText())) throw new Error('quote damaged');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  const row = gina.locator('.msg-list li', { hasText: 'Re: Status colours' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  { const q = gina.getByRole('button', { name: 'Show quoted text' }); await q.waitFor({ timeout: 5000 }).catch(() => {}); if (await q.count()) await q.click(); } // quoted history is folded away at first
  const f = gina.frameLocator('iframe.mail-html');
  const late = f.locator('blockquote span', { hasText: 'Delayed' });
  await late.waitFor();
  const c = await late.evaluate((el) => getComputedStyle(el).color);
  if (c !== 'rgb(204, 0, 0)') throw new Error('recipient sees ' + c);
  const ff = await f.locator('blockquote span', { hasText: 'Dear team' }).evaluate((el) => getComputedStyle(el).fontFamily);
  if (!/Georgia/.test(ff)) throw new Error('recipient font ' + ff);
  const fz = await f.locator('blockquote span', { hasText: 'Globex office' }).evaluate((el) => getComputedStyle(el).fontSize);
  if (fz !== '12px') throw new Error('recipient size ' + fz);
  await gina.screenshot({ path: `${SP}/shots/recipient-colours.png` });
}, gina);

const word = (w) => ed().locator('span', { hasText: w });
await step('colour-your-own-text', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Moved');
  await ed().click();
  // Undo / redo: nothing to undo in a new message; then typing, undo and redo with the buttons.
  const undo = page.getByRole('button', { name: 'Undo (Ctrl+Z)' }), redo = page.getByRole('button', { name: 'Redo (Ctrl+Y)' });
  if (!(await undo.isDisabled()) || !(await redo.isDisabled())) throw new Error('undo/redo should start disabled');
  await page.keyboard.type('Draft words');
  await page.waitForTimeout(600); // a new undo step starts after a pause
  await page.keyboard.type(' extra');
  await undo.click();
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap').innerText.trim() === 'Draft words');
  if (await redo.isDisabled()) throw new Error('redo should be available');
  await redo.click();
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap').innerText.trim() === 'Draft words extra');
  if (!(await redo.isDisabled())) throw new Error('nothing left to redo');
  await undo.click();
  await undo.click();
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap').innerText.trim() === '');
  if (!(await undo.isDisabled())) throw new Error('nothing left to undo');
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror')); // still typing in the message

  await page.keyboard.type('Meeting moved to Friday please confirm');
  await ed().locator('p', { hasText: 'Friday' }).waitFor();
  // Select "Friday" with the keyboard: end of line, back over " please confirm", then Shift over "Friday".
  await page.keyboard.press('End');
  for (let i = 0; i < ' please confirm'.length; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 'Friday'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('button', { name: 'Text colour' }).click();
  await page.getByRole('dialog', { name: 'Text colour' }).screenshot({ path: `${SP}/shots/colour-palette.png` });
  await page.getByRole('option', { name: 'Red' }).click();
  await word('Friday').waitFor();
  if ((await colorOf(word('Friday'))) !== 'rgb(197, 34, 31)') throw new Error('red: ' + await colorOf(word('Friday')));
  if ((await word('Friday').innerText()) !== 'Friday') throw new Error('coloured more than the selection');
  const bar = await page.getByRole('button', { name: 'Text colour' }).locator('.color-bar').evaluate((b) => getComputedStyle(b).backgroundColor);
  if (bar !== 'rgb(197, 34, 31)') throw new Error('button bar ' + bar);
});

await step('automatic-removes-it', async () => {
  await page.getByRole('button', { name: 'Text colour' }).click();
  if ((await page.getByRole('option', { name: 'Red' }).getAttribute('aria-selected')) !== 'true') throw new Error('current colour not marked');
  await page.getByRole('option', { name: 'Automatic' }).click();
  await page.waitForFunction(() => !document.querySelector('.compose-editor .tiptap span[style*="color"]'), null, { timeout: 5000 });
  // Picking hands focus back to the editor on the next frame (as a person would see it).
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
});

await step('colour-with-the-keyboard', async () => {
  await page.getByRole('button', { name: 'Text colour' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Text colour' }).waitFor();
  await page.keyboard.press('Escape'); // closes only the palette
  await page.getByRole('dialog', { name: 'Text colour' }).waitFor({ state: 'detached' });
  if (!(await page.locator('.compose-editor').count())) throw new Error('message closed');
  await page.getByRole('button', { name: 'Text colour' }).focus();
  await page.keyboard.press('Enter');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight'); // Automatic -> ... -> Blue
  await page.keyboard.press('Enter');
  await word('Friday').waitFor();
  if ((await colorOf(word('Friday'))) !== 'rgb(26, 115, 232)') throw new Error('blue: ' + await colorOf(word('Friday')));
});

await step('highlight-a-word', async () => {
  // Select "please" (between "Friday " and " confirm").
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.keyboard.press('End');
  for (let i = 0; i < ' confirm'.length; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 'please'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('button', { name: 'Highlight colour' }).click();
  await page.getByRole('dialog', { name: 'Highlight colour' }).screenshot({ path: `${SP}/shots/highlight-palette.png` });
  await page.getByRole('option', { name: 'Yellow' }).click();
  const hl = ed().locator('span', { hasText: 'please' });
  await hl.waitFor();
  if ((await hl.evaluate((el) => el.style.backgroundColor)) !== 'rgb(254, 240, 138)') throw new Error('bg ' + await hl.evaluate((el) => el.style.backgroundColor));
  if ((await hl.innerText()) !== 'please') throw new Error('highlighted more than the selection');
  // "None" takes it off again; then highlight once more for the recipient.
  await page.getByRole('button', { name: 'Highlight colour' }).click();
  if ((await page.getByRole('option', { name: 'Yellow' }).getAttribute('aria-selected')) !== 'true') throw new Error('current highlight not marked');
  await page.getByRole('option', { name: 'None' }).click();
  await page.waitForFunction(() => !document.querySelector('.compose-editor .tiptap span[style*="background-color"]'), null, { timeout: 5000 });
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.getByRole('button', { name: 'Highlight colour' }).click();
  await page.getByRole('option', { name: 'Green' }).click();
  await hl.waitFor();
  if ((await colorOf(word('Friday'))) !== 'rgb(26, 115, 232)') throw new Error('text colour lost');
});

const selectLast = async (w) => {
  await page.waitForTimeout(100);
  await ed().focus();
  await page.keyboard.press('End');
  for (let i = 0; i < w.length; i++) await page.keyboard.press('Shift+ArrowLeft');
};
await step('custom-text-colour-by-code', async () => {
  await selectLast('confirm');
  await page.getByRole('button', { name: 'Text colour' }).click();
  await page.getByLabel('Colour code').fill('#eee');
  await page.getByText('Light colours are hard to read on a white page.').waitFor();
  await page.getByLabel('Colour code').fill('0B8043');
  if (await page.locator('.color-warn').count()) throw new Error('warning for a readable colour');
  await page.getByRole('dialog', { name: 'Text colour' }).screenshot({ path: `${SP}/shots/custom-colour.png` });
  await page.getByLabel('Colour code').press('Enter'); // applies; must not send the message
  const w = ed().locator('span', { hasText: 'confirm' });
  await w.waitFor();
  if ((await colorOf(w)) !== 'rgb(11, 128, 67)') throw new Error('custom colour ' + await colorOf(w));
  if ((await page.getByLabel('Subject').inputValue()) !== 'Moved') throw new Error('Enter sent or closed the message'); // sending closes the window
  // It is offered again as a recent colour, marked as the current one.
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.getByRole('button', { name: 'Text colour' }).click();
  const recent = page.getByRole('option', { name: 'Custom #0b8043' });
  if ((await recent.getAttribute('aria-selected')) !== 'true') throw new Error('recent colour not offered/marked');
  await page.keyboard.press('Escape');
});

await step('custom-highlight-with-the-colour-well', async () => {
  await selectLast('confirm');
  await page.getByRole('button', { name: 'Highlight colour' }).click();
  await page.getByLabel('Choose a custom colour').fill('#333333');
  await page.getByText('Dark highlights make the text on them hard to read.').waitFor();
  await page.getByLabel('Choose a custom colour').fill('#ffd6a5');
  await page.getByRole('dialog', { name: 'Highlight colour' }).getByRole('button', { name: 'Apply' }).click();
  const w = ed().locator('span', { hasText: 'confirm' });
  await page.waitForFunction(() => [...document.querySelectorAll('.compose-editor .tiptap span')].some((s) => s.textContent === 'confirm' && s.style.backgroundColor === 'rgb(255, 214, 165)'), null, { timeout: 5000 });
  if ((await colorOf(w)) !== 'rgb(11, 128, 67)') throw new Error('text colour lost: ' + await colorOf(w));
});

await step('font-size', async () => {
  // Select by position (1..8 is "Meeting", the first word); then use the menu.
  const sel = (from, to) => page.evaluate(([f, t]) => { const e = document.querySelector('.tiptap').editor; e.chain().focus().setTextSelection({ from: f, to: t }).run(); }, [from, to]);
  const size = page.getByLabel('Font size');
  await sel(1, 8);
  if ((await size.inputValue()) !== 'Normal') throw new Error('starts at ' + await size.inputValue());
  await size.selectOption('Large');
  const w = ed().locator('span', { hasText: 'Meeting' });
  await w.waitFor();
  if ((await w.evaluate((el) => el.style.fontSize)) !== '18px') throw new Error('size ' + await w.evaluate((el) => el.style.fontSize));
  if ((await w.innerText()) !== 'Meeting') throw new Error('sized more than the selection');
  // The menu shows the size where the cursor is.
  await sel(3, 3);
  await page.waitForFunction(() => document.querySelector('[aria-label="Font size"]').value === 'Large');
  await sel(12, 12);
  await page.waitForFunction(() => document.querySelector('[aria-label="Font size"]').value === 'Normal');
  // Back to normal, then large again for the recipient.
  await sel(1, 8);
  await size.selectOption('Normal');
  await page.waitForFunction(() => ![...document.querySelectorAll('.compose-editor .tiptap span')].some((s) => s.style.fontSize));
  await sel(1, 8);
  await size.selectOption('Large');
  await w.waitFor();
  await page.locator('.compose-toolbar').screenshot({ path: `${SP}/shots/toolbar.png` });
});

await step('font-menu', async () => {
  const sel = (from, to) => page.evaluate(([f, t]) => { const e = document.querySelector('.tiptap').editor; e.chain().focus().setTextSelection({ from: f, to: t }).run(); }, [from, to]);
  const font = page.getByLabel('Font', { exact: true });
  await sel(9, 14); // "moved"
  if ((await font.inputValue()) !== 'Sans Serif') throw new Error('starts at ' + await font.inputValue());
  await font.selectOption('Georgia');
  const w = ed().locator('span', { hasText: /^moved$/ });
  await w.waitFor();
  if (!/^Georgia, serif$/.test(await w.evaluate((el) => el.style.fontFamily))) throw new Error('font ' + await w.evaluate((el) => el.style.fontFamily));
  await sel(11, 11);
  await page.waitForFunction(() => document.querySelector('[aria-label="Font"]').value === 'Georgia');
  await sel(9, 14);
  await font.selectOption('Sans Serif');
  await page.waitForFunction(() => ![...document.querySelectorAll('.compose-editor .tiptap span')].some((s) => s.style.fontFamily));
  await sel(9, 14);
  await font.selectOption('Courier New');
  await w.waitFor();
  if (!/Courier New/.test(await w.evaluate((el) => el.style.fontFamily))) throw new Error('courier');
  await sel(11, 11);
  await page.waitForFunction(() => document.querySelector('[aria-label="Font"]').value === 'Courier New');
});

// Toolbar menus: open one, pick an item (or read whether it is checked, then close with Escape).
const openMenu = async (button, menu = button) => { await page.getByRole('button', { name: button, exact: true }).click(); const m = page.getByRole('menu', { name: menu }); await m.waitFor(); return m; };
const menuPick = async (button, role, item) => { const m = await openMenu(button); await m.getByRole(role, { name: item, exact: true }).click(); await m.waitFor({ state: 'detached' }); };
const menuChecked = async (button, role, item) => { const m = await openMenu(button); const v = await m.getByRole(role, { name: item, exact: true }).getAttribute('aria-checked'); await page.keyboard.press('Escape'); await m.waitFor({ state: 'detached' }); return v; };
const editorFocused = () => page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));

await step('text-alignment', async () => {
  const para = ed().locator('p', { hasText: 'Meeting moved' });
  const align = () => para.evaluate((el) => el.style.textAlign);
  await page.evaluate(() => document.querySelector('.tiptap').editor.chain().focus().setTextSelection(3).run());
  if ((await menuChecked('Alignment', 'menuitemradio', 'Align left')) !== 'true') throw new Error('left should be checked by default');
  await menuPick('Alignment', 'menuitemradio', 'Centre');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap p').style.textAlign === 'center');
  if ((await menuChecked('Alignment', 'menuitemradio', 'Centre')) !== 'true') throw new Error('Centre not checked');
  // Keyboard: open the menu with Enter, move with the arrows, pick with Enter.
  await page.getByRole('button', { name: 'Alignment', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menu', { name: 'Alignment' }).waitFor();
  await page.keyboard.press('ArrowDown'); // from Centre (checked) to Align right
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap p').style.textAlign === 'right');
  await editorFocused();
  await page.keyboard.press('Control+Shift+E');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap p').style.textAlign === 'center');
  await menuPick('Alignment', 'menuitemradio', 'Align left');
  await page.waitForFunction(() => !document.querySelector('.compose-editor .tiptap p').style.textAlign);
  await menuPick('Alignment', 'menuitemradio', 'Centre');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap p').style.textAlign === 'center');
  if ((await align()) !== 'center') throw new Error('centre again: ' + await align());
  if (!(await page.locator('.compose-editor').count())) throw new Error('Escape closed the message');
  await page.locator('.compose-toolbar').screenshot({ path: `${SP}/shots/toolbar.png` });
});

await step('indent-paragraph', async () => {
  const para = ed().locator('p', { hasText: 'Meeting moved' });
  const ml = () => para.evaluate((el) => el.style.marginLeft);
  await page.evaluate(() => document.querySelector('.tiptap').editor.chain().focus().setTextSelection(3).run());
  await menuPick('More formatting', 'menuitem', 'Increase indent (Ctrl+])');
  await page.locator('.compose-toolbar').screenshot({ path: `${SP}/shots/toolbar-after.png` });
  await menuPick('More formatting', 'menuitem', 'Increase indent (Ctrl+])');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap p').style.marginLeft === '80px');
  await menuPick('More formatting', 'menuitem', 'Decrease indent (Ctrl+[)');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap p').style.marginLeft === '40px');
  await editorFocused();
  await page.keyboard.press('Control+]');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap p').style.marginLeft === '80px');
  await page.keyboard.press('Control+[');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap p').style.marginLeft === '40px');
  if ((await para.evaluate((el) => el.style.textAlign)) !== 'center') throw new Error('alignment lost');
  // The More menu shows on/off choices as checked.
  if ((await menuChecked('More formatting', 'menuitemcheckbox', 'Strikethrough')) !== 'false') throw new Error('strike shown as on');
  const m = await openMenu('More formatting');
  await m.screenshot({ path: `${SP}/shots/more-menu.png` });
  await page.keyboard.press('Escape');
  await m.waitFor({ state: 'detached' });
});

await step('link-dialog', async () => {
  // Record any send (form submission) with what had focus, to catch an accidental one.
  await page.evaluate(() => { window.__submits = []; document.addEventListener('submit', (e) => window.__submits.push(`${e.submitter?.getAttribute('aria-label') || e.submitter?.textContent} / active ${document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName} / ${new Error().stack.split('\n').slice(1, 4).join(' | ')}`), true); });
  const guard = async () => { const s2 = await page.evaluate(() => window.__submits || []); if (s2.length) throw new Error('message was sent: ' + s2.join(' ;; ')); };
  page.__guard = guard;
  const linkDialog = (name) => page.getByRole('dialog', { name });
  await page.evaluate(() => document.querySelector('.tiptap').editor.chain().focus('end').run());
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.keyboard.press('Enter');
  await page.keyboard.type('See the agenda');
  await guard();
  await page.evaluate(() => { const e = document.querySelector('.tiptap').editor; let at = 0; e.state.doc.descendants((n, pos) => { if (n.isText && n.text.endsWith('See the agenda')) at = pos + n.text.length; }); e.chain().focus().setTextSelection({ from: at - 6, to: at }).run(); });
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.keyboard.press('Control+k');
  const d = linkDialog('Insert link');
  await d.waitFor();
  const shown = await d.getByLabel('Text to display').inputValue();
  if (shown !== 'agenda') throw new Error('selected text not filled in: ' + JSON.stringify(shown));
  const addr = d.getByRole('textbox', { name: 'Web address' });
  await addr.fill('javascript:alert(1)');
  await d.getByText('Enter a web address').waitFor();
  if (!(await d.getByRole('button', { name: 'Insert' }).isDisabled())) throw new Error('bad address accepted');
  await addr.fill('example.com/agenda');
  if ((await d.getByRole('link', { name: 'Test this link' }).getAttribute('href')) !== 'https://example.com/agenda') throw new Error('test link');
  await d.screenshot({ path: `${SP}/shots/link-dialog.png` });
  await addr.press('Enter'); // inserts the link; must not send the message
  await d.waitFor({ state: 'detached' });
  const a = ed().locator('a[href="https://example.com/agenda"]');
  await a.waitFor();
  if ((await a.innerText()) !== 'agenda') throw new Error('link text ' + await a.innerText());
  if ((await page.getByLabel('Subject').inputValue()) !== 'Moved') throw new Error('Enter sent the message');
  // Edit it: the dialog opens with the link's text and address.
  await page.evaluate(() => { const e = document.querySelector('.tiptap').editor; let at = 0; e.state.doc.descendants((n, pos) => { if (!at && n.isText && n.text === 'agenda') at = pos + 2; }); e.chain().focus().setTextSelection(at).run(); });
  await page.getByRole('button', { name: 'Edit link (Ctrl+K)' }).click();
  const d2 = linkDialog('Edit link');
  await d2.waitFor();
  if ((await d2.getByRole('textbox', { name: 'Web address' }).inputValue()) !== 'https://example.com/agenda') throw new Error('address not filled in');
  await d2.getByLabel('Text to display').fill('meeting agenda');
  await d2.getByRole('button', { name: 'Save' }).click();
  await ed().locator('a[href="https://example.com/agenda"]', { hasText: 'meeting agenda' }).waitFor();
  // An email link from scratch (nothing selected), then remove it again: the text stays.
  await page.evaluate(() => document.querySelector('.tiptap').editor.chain().focus('end').run());
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.keyboard.type(' or ask ');
  await page.keyboard.press('Control+k');
  const d3 = linkDialog('Insert link');
  await d3.waitFor();
  await d3.getByRole('radio', { name: 'Email address' }).check();
  await d3.getByLabel('Text to display').fill('Olivia');
  await d3.getByRole('textbox', { name: 'Email address' }).fill('olivia@acme.com');
  await d3.getByRole('button', { name: 'Insert' }).click();
  const mail = ed().locator('a[href="mailto:olivia@acme.com"]', { hasText: 'Olivia' });
  await mail.waitFor();
  await page.evaluate(() => { const e = document.querySelector('.tiptap').editor; let at = 0; e.state.doc.descendants((n, pos) => { if (!at && n.isText && n.text === 'Olivia') at = pos + 2; }); e.chain().focus().setTextSelection(at).run(); });
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  await page.keyboard.press('Control+k');
  const d4 = linkDialog('Edit link');
  await d4.waitFor();
  if (!(await d4.getByRole('radio', { name: 'Email address' }).isChecked())) throw new Error('email kind not restored');
  await d4.getByRole('button', { name: 'Remove link' }).click();
  await mail.waitFor({ state: 'detached' });
  if (!/or ask Olivia/.test(await ed().innerText())) throw new Error('text lost on remove');
});

await step('recipient-sees-your-colour', async () => {
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  const row = gina.locator('.msg-list li', { hasText: 'Moved' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const f = gina.frameLocator('iframe.mail-html');
  const fri = f.locator('span', { hasText: 'Friday' });
  await fri.waitFor();
  const c = await fri.evaluate((el) => getComputedStyle(el).color);
  if (c !== 'rgb(26, 115, 232)') throw new Error('recipient sees ' + c);
  const bg = await f.locator('span', { hasText: 'please' }).evaluate((el) => getComputedStyle(el).backgroundColor);
  const cc = await f.locator('span', { hasText: 'confirm' }).evaluate((el) => `${getComputedStyle(el).color}/${getComputedStyle(el).backgroundColor}`);
  if (cc !== 'rgb(11, 128, 67)/rgb(255, 214, 165)') throw new Error('recipient custom ' + cc);
  const fs = await f.locator('span', { hasText: /^Meeting$/ }).evaluate((el) => getComputedStyle(el).fontSize);
  if (fs !== '18px') throw new Error('recipient size ' + fs);
  const mf = await f.locator('span', { hasText: /^moved$/ }).evaluate((el) => getComputedStyle(el).fontFamily);
  if (!/Courier New/.test(mf)) throw new Error('recipient font ' + mf);
  const ta = await f.locator('p', { hasText: 'Meeting moved' }).evaluate((el) => getComputedStyle(el).textAlign);
  if (ta !== 'center') throw new Error('recipient alignment ' + ta);
  const href = await f.locator('a', { hasText: 'meeting agenda' }).getAttribute('href');
  if (href !== 'https://example.com/agenda') throw new Error('recipient link ' + href);
  const ind = await f.locator('p', { hasText: 'Meeting moved' }).evaluate((el) => getComputedStyle(el).marginLeft);
  if (ind !== '40px') throw new Error('recipient indent ' + ind);
  const list = await api(gina, 'GET', '/mail/messages?folder=INBOX');
  const sent = list.body.messages.find((x) => x.subject === 'Moved');
  const text = (await api(gina, 'GET', `/mail/messages/${sent.uid}?folder=INBOX`)).body.text;
  if (!/^ {4}Meeting moved/m.test(text)) throw new Error('plain text not indented: ' + JSON.stringify(text.slice(0, 60)));
  if (bg !== 'rgb(187, 247, 208)') throw new Error('recipient highlight ' + bg);
}, gina);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
