import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import JSZip from '../../server/node_modules/jszip/lib/index.js';
import fs from 'node:fs';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(m.text()));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const text = async (k) => (await cell(k).innerText()).trim();
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const expectCells = async (want) => { for (const [k, v] of Object.entries(want)) { const t = await text(k); if (t !== v) throw new Error(`${k}: "${t}" not "${v}"`); } };
const typeIn = async (k, s) => { await cell(k).click(); await page.keyboard.type(s); await page.keyboard.press('Enter'); };
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
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Orders', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: {
    A1: 'Item', B1: 'Amount', A2: 'pear', B2: '120', A3: 'fig', B3: '80', A4: 'banana', B4: '0',
    H1: 'Item', I1: 'Amount', H2: 'pear', I2: '>50',
  } }] } })).body;
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B2').waitFor();
});
await step('a function of one value given a range fills a cell for each', async () => {
  await typeIn('C2', '=LEN(A2:A4)');
  await expectCells({ C2: '4', C3: '3', C4: '6' });
  await typeIn('D2', '=IF(B2:B4>100, "big", "small")');
  await expectCells({ D2: 'big', D3: 'small', D4: 'small' });
  // One cell that can't be worked out shows its error; the others keep their values.
  await typeIn('E2', '=100/B2:B4');
  await expectCells({ E3: '1.25', E4: '#DIV/0!' });
  await typeIn('F2', '=ARRAYFORMULA(IFERROR(100/B2:B4, "none"))');
  await expectCells({ F3: '1.25', F4: 'none' });
  await page.screenshot({ path: `${SP}/shots/funcs-lift.png` });
  // Something in the way: the formula's cell says so.
  await typeIn('G3', 'x');
  await typeIn('G2', '=UPPER(A2:A4)');
  await expectCells({ G2: '#SPILL!' });
});
await step('the new functions are suggested with help on their arguments', async () => {
  await cell('A7').click();
  await page.keyboard.type('=t.te');
  const list = page.getByRole('listbox', { name: 'Function suggestions' });
  await list.waitFor();
  const names = await list.getByRole('option').locator('b').allInnerTexts();
  if (!names.includes('T.TEST')) throw new Error(names.join(','));
  await page.keyboard.press('Tab');
  const help = page.getByRole('status', { name: 'Function help' });
  if ((await help.locator('b').innerText()) !== 'range1') throw new Error('first argument bold');
  if (!(await help.innerText()).includes('p-value of a t-test')) throw new Error(await help.innerText());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});
await step('statistics, loans, dates in words and database functions give Excel\'s answers', async () => {
  await typeIn('A8', '=ROUND(NORM.S.INV(0.975), 4)');
  await typeIn('A9', '=ROUND(IPMT(0.1/12, 1, 36, 8000), 2)');
  await typeIn('A10', '=TO_DATE(DATEVALUE("9 Nov 2026") + 7)');
  await typeIn('A11', '=DSUM(A1:B4, "Amount", H1:I2)');
  await typeIn('A12', '=FORMULATEXT(A8)');
  await typeIn('A13', '=ROUND(T.INV.2T(0.05, 10), 3)');
  await expectCells({ A8: '1.96', A9: '-66.67', A10: '2026-11-16', A11: '120', A12: '=ROUND(NORM.S.INV(0.975), 4)', A13: '2.228' });
  await typeIn('A14', '=NORM.INV(2, 0, 1)');
  await expectCells({ A14: '#NUM!' });
  // ISDATE, EPOCHTODATE, ISREF and CELL
  await typeIn('A15', '=ISDATE(A10)');
  await typeIn('A16', '=EPOCHTODATE(1700000000)');
  await typeIn('A17', '=ISREF(B2:C3)');
  await typeIn('A18', '=CELL("address", B2:C3)&" "&CELL("type", A1)');
  await expectCells({ A15: 'TRUE', A16: '2023-11-14 22:13:20', A17: 'TRUE', A18: '$B$2 l' });
  // SHEET, SHEETS, REGEXTEST, PERCENTOF, BITLSHIFT
  await typeIn('A19', '=SHEET()&"/"&SHEETS()');
  await typeIn('A20', '=REGEXTEST(A2, "^P", 1)');
  await typeIn('A21', '=PERCENTOF(B2, B2:B4)');
  await typeIn('A22', '=BITLSHIFT(5, 3)');
  await expectCells({ A19: '1/1', A20: 'TRUE', A21: '0.6', A22: '40' });
  // complex numbers
  await typeIn('A23', '=IMPRODUCT(COMPLEX(3, 4), "5-3i")');
  await typeIn('A24', '=IMABS("3+4i")');
  await expectCells({ A23: '27+11i', A24: '5' });
  // older names, as in files from Excel 2007
  await typeIn('A25', '=ROUND(FDIST(15.2068649, 6, 4), 4)');
  await typeIn('A26', '=ROUND(BETA.INV(0.685470581, 8, 10, 1, 3), 4)');
  await expectCells({ A25: '0.01', A26: '2' });
  // discounted securities and Treasury bills
  await typeIn('A27', '=TBILLPRICE(DATE(2008,3,31), DATE(2008,6,1), 0.09)');
  await typeIn('A28', '=ROUND(PRICEDISC(DATE(2008,2,16), DATE(2008,3,1), 0.0525, 100, 2), 5)');
  await expectCells({ A27: '98.45', A28: '99.79583' });
  // bonds paying coupons
  await typeIn('A29', '=ROUND(PRICE(DATE(2008,2,15), DATE(2017,11,15), 0.0575, 0.065, 100, 2, 0), 5)');
  await typeIn('A30', '=COUPNCD(DATE(2011,1,25), DATE(2011,11,15), 2, 1)');
  await expectCells({ A29: '94.63436', A30: '2011-05-15' });
  // Bessel functions
  await typeIn('A31', '=ROUND(BESSELJ(1.9, 2), 6)');
  await typeIn('A32', '=ROUND(BESSELK(1.5, 1), 6)');
  await expectCells({ A31: '0.329926', A32: '0.277388' });
  // GROUPBY: the fruit's amounts summed per item, with a total
  await typeIn('K1', '=GROUPBY(A2:A4, B2:B4, SUM)');
  await expectCells({ K1: 'banana', L1: '0', K2: 'fig', L2: '80', K3: 'pear', L3: '120', K4: 'Total', L4: '200' });
  // PIVOTBY: items down, amounts over 50 or not across
  await typeIn('K7', '=PIVOTBY(A2:A4, B2:B4>50, B2:B4, SUM, 0, 0, 1, 0)');
  await expectCells({ L7: 'FALSE', M7: 'TRUE', K8: 'banana', L8: '0', K9: 'fig', M9: '80', K10: 'pear', M10: '120' });
  // a LAMBDA named with LET, called by its name, with a parameter left out; TRIMRANGE
  await typeIn('A33', '=LET(tax, LAMBDA(x, rate, x * IF(ISOMITTED(rate), 1.2, 1 + rate)), tax(100) & "/" & tax(100, 0.1))');
  await typeIn('A34', '=ROWS(TRIMRANGE(H1:I30))&"/"&ROWS(A1:B20)');
  await expectCells({ A33: '120/110', A34: '2/20' });
  // A14 holds #NUM!: COUNT, MATCH and VLOOKUP over ranges with it still work, as in Excel
  await typeIn('A35', '=COUNT(A8:A14)&"/"&MATCH("fig", A1:A20, 0)&"/"&VLOOKUP("fig", A1:B20, 2, FALSE)');
  await expectCells({ A35: '4/3/80' });
  // INDEX with 0 for the row: the whole Amount column, spilled
  await typeIn('N1', '=INDEX(A1:B4, 0, 2)');
  await expectCells({ N1: 'Amount', N2: '120', N3: '80', N4: '0' });
  // ROUND halves away from zero; "50%" typed as text counts as 0.5 in arithmetic
  await typeIn('P1', '50%');
  await typeIn('P2', '=ROUND(-2.5, 0)&"/"&ROUND(2.675, 2)&"/"&P1*2');
  await expectCells({ P2: '-3/2.68/1' });
  // TEXT with times, sections and fractions
  await typeIn('P3', '=TEXT(TIME(14, 30, 0), "h:mm AM/PM")&"|"&TEXT(-5, "0;(0)")&"|"&TEXT(1.5, "# ?/?")');
  await expectCells({ P3: '2:30 PM|(5)|1 1/2' });
  // lists of k and of conditions; an approximate VLOOKUP on unsorted amounts gives Excel's answer
  await typeIn('P4', '=SUM(LARGE(B2:B4, {1,2}))&"|"&SUM(SUMIFS(B2:B4, A2:A4, {"pear","fig"}))&"|"&VLOOKUP(100, B2:B4, 1, TRUE)');
  await expectCells({ P4: '200|200|0' }); // 120, 80, 0 unsorted: the halving search ends on 0, as Excel's does
  // a value typed into SUM counts; text in cells doesn't
  await typeIn('P5', '=SUM(B2:B4, "5")&"|"&SUM(A2:B4)&"|"&COUNT("1", TRUE, A2)');
  await expectCells({ P5: '205|200|2' });
  await typeIn('P6', '=IF(0.1+0.2=0.3, "equal", "not")&"|"&COUNTIF(P7:P8, 0.3)');
  await typeIn('P7', '=0.1+0.2');
  await typeIn('P8', '0.3');
  await expectCells({ P6: 'equal|2' }); // compared to 15 digits, as Excel does
  await typeIn('P9', '=FIXED(-1234.5, 0, TRUE)&"|"&DOLLAR(-1.005, 2)&"|"&LEN(TRIM(CHAR(9)&"a  b"))');
  await expectCells({ P9: '-1235|($1.01)|4' });
  // text in reading order: accented letters with their letter (Äpfel before Zebra), numbers before any text
  await typeIn('P10', '=("Äpfel"<"Zebra")&"|"&("éclair"<"f")&"|"&(9<"1")&"|"&COUNTIF(P11:P12, "<m")');
  await typeIn('P11', 'Ålesund');
  await typeIn('P12', 'zebra');
  await expectCells({ P10: 'TRUE|TRUE|TRUE|1' });
  // TEXT with General, digits around a dash, elapsed hours and a scientific carry
  await typeIn('P13', '=TEXT(1234.5, "General")&"|"&TEXT(42, "000-000")&"|"&TEXT(1.5, "[h]:mm")&"|"&TEXT(99.995, "0.00E+00")');
  await expectCells({ P13: '1234.5|000-042|36:00|1.00E+02' });
  // a fractional number of digits is taken as whole (as Excel does), and a tiny amount still rounds up
  await typeIn('P14', '=ROUNDUP(2.5, -0.5)&"|"&ROUNDUP(1E-10, 1)&"|"&TRUNC(7, 0.5)&"|"&CHAR(65.9)&"|"&IFERROR(CEILING(2.5, -1), "no")');
  await expectCells({ P14: '3|0.1|7|A|no' });
  // text read as numbers: (5) is -5, a time of day, a date's day number; counts of characters taken as whole numbers
  await typeIn('P15', '=("(5)"+0)&"|"&VALUE("2:30 PM")*24&"|"&VALUE("2026-11-20")&"|"&LEFT("Hello", 1.9)&"|"&PROPER("İstanbul")');
  await expectCells({ P15: '-5|14.5|46346|H|İstanbul' });
  // WEEKDAY and WEEKNUM types past 11, a fraction of a month dropped, two-digit years from 1900
  await typeIn('P16', '=WEEKDAY(DATE(2024,8,31),14)&"|"&WEEKNUM(DATE(2024,3,31),21)&"|"&TEXT(EDATE(DATE(2025,12,31),-0.5),"yyyy-mm-dd")&"|"&YEAR(DATE(100,1,1))');
  await expectCells({ P16: '3|13|2025-12-31|2000' });
  // a ~ makes * plain text; an approximate lookup of text among numbers finds nothing
  await typeIn('P17', '=COUNTIF(P18:P19, "a~*b")&"|"&IFERROR(LOOKUP("eclair", P20:P21), "none")');
  await typeIn('P18', 'a*b');
  await typeIn('P19', 'axb');
  await typeIn('P20', '1');
  await typeIn('P21', '2');
  await expectCells({ P17: '1|none' });
  // LARGE of k 1.5 is the largest (it showed nothing); MODE of a tie is the first in the range
  await typeIn('P22', '=LARGE(P20:P21, 1.5)&"|"&MODE(3, 1, 4, 1, 3)');
  await expectCells({ P22: '2|3' });
  // depreciation part-way through a period declines smoothly; no rate for a negative number of periods
  await typeIn('P23', '=ROUND(DDB(10000, 1000, 5, 2.5), 2)&"|"&IFERROR(RATE(-5, 1000, 250000), "none")');
  await expectCells({ P23: '1859.03|none' });
  // "" is text, not 0 or blank; AND passes over text in a cell
  await typeIn('P24', '=ISTEXT("")&"|"&IFERROR(5+"", "err")&"|"&AND(3, P18)&"|"&ISBLANK(P25)');
  await typeIn('P25', '=""');
  await expectCells({ P24: 'TRUE|err|TRUE|FALSE' });
  // an answer that's no number is #NUM! at once, not carried through a comparison as FALSE
  await typeIn('P26', '=IFERROR(1<-10^1.5, "num")&"|"&IFERROR(0^0, "num")&"|"&-2^2');
  await expectCells({ P26: 'num|num|4' });
  // ROW of a range gives every row's number in an array formula
  await typeIn('P27', '=SUMPRODUCT(ROW(P20:P21)*P20:P21)');
  await expectCells({ P27: '62' });
  // numbers typed with thousands, a currency sign or % are kept as numbers, in that format
  await typeIn('Q1', '1,234');
  await typeIn('Q2', '$5.50');
  await page.waitForTimeout(800); // (edits close together are one Undo step)
  await typeIn('Q3', '12.5%');
  await expectCells({ Q3: '12.5%' });
  await cell('Q3').click();
  await page.keyboard.press('Control+z'); // Q3's number and its format together, in one step
  await until(async () => (await text('Q3')) === '' && (await text('Q2')) === '$5.50');
  await page.keyboard.press('Control+y');
  await until(async () => (await text('Q3')) === '12.5%');
  await typeIn('Q4', '=SUM(Q1:Q2)&"|"&Q3*8');
  await expectCells({ Q1: '1,234', Q2: '$5.50', Q3: '12.5%', Q4: '1239.5|1' });
  if (await cell('Q3').evaluate((td) => getComputedStyle(td).textAlign) !== 'right') throw new Error('a number lines up on the right');
  // dates and times typed as people write them are dates, shown as typed
  await typeIn('R1', '20/11/2026');
  await typeIn('R2', '25 Dec 2026');
  await typeIn('R3', '2:30 PM');
  await typeIn('R4', '=R2-R1&"|"&TEXT(R1, "dddd")&"|"&HOUR(R3)');
  await expectCells({ R1: '20/11/2026', R2: '25 Dec 2026', R3: '2:30 PM', R4: '35|Friday|14' });
  await typeIn('R5', "'1-2");
  await expectCells({ R5: '1-2' }); // a ' in front: kept as text, the ' not shown
  await typeIn('R6', '20/11/2026 14:30');
  await expectCells({ R6: '20/11/2026 14:30' });
  // pasted from another program (tab-separated): numbers and dates as written there become numbers and dates
  await cell('S1').click();
  await page.evaluate((text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); document.querySelector('.grid-wrap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); },
    'Item\tPrice\tShare\tDue\nDesk\t$1,250.00\t40%\t05/12/2026\nLamp\t£80\t60%\t20 Dec 2026');
  await typeIn('S4', '=SUM(T2:T3)&"|"&SUM(U2:U3)&"|"&(V3-V2)');
  await expectCells({ S1: 'Item', T2: '$1,250.00', U2: '40%', V2: '05/12/2026', T3: '£80', V3: '20 Dec 2026', S4: '1330|1|15' });
  await page.screenshot({ path: `${SP}/shots/funcs-values.png` });
});
await step('newer functions are written the way Excel expects in the .xlsx download', async () => {
  await page.waitForTimeout(1500); // saved
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Excel (.xlsx)' }).click()]);
  const file = `${SP}/funcs-dl.xlsx`;
  await dl.saveAs(file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  if (!xml.includes('_xlfn.NORM.S.INV(0.975)')) throw new Error(xml.match(/<f>[^<]*NORM[^<]*<\/f>/)?.[0] || 'no NORM formula');
  if (!xml.includes('_xlfn.T.INV.2T(0.05,10)') && !xml.includes('_xlfn.T.INV.2T(0.05, 10)')) throw new Error(xml.match(/<f>[^<]*T\.INV[^<]*<\/f>/)?.[0] || 'no T.INV');
  if (!/<f>[^<]*IPMT\(/.test(xml) || /_xlfn\.IPMT/.test(xml)) throw new Error('IPMT is an old function: no prefix');
  // typed dates, a date and time, and a time are Excel dates and times (numbers), not text
  const num = (k) => new RegExp(`<c r="${k}" s="\\d+"><v>([\\d.]+)</v>`).exec(xml)?.[1];
  if (num('R1') !== '46346' || !/^46346\.6041/.test(num('R6') || '') || !/^0\.6041/.test(num('R3') || '')) throw new Error(JSON.stringify([num('R1'), num('R6'), num('R3')]));
});
await step('and in the .ods download, as OpenDocument dates and times', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as OpenDocument (.ods)' }).click()]);
  const file = `${SP}/funcs-dl.ods`;
  await dl.saveAs(file);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('content.xml').async('string');
  if (!xml.includes('office:date-value="2026-11-20T14:30:00"')) throw new Error('the date and time (R6)');
  if (!xml.includes('office:time-value="PT14H30M00S"')) throw new Error('the time (R3)');
  if (!/<number:time-style[^>]*><number:hours\/>.*?<number:am-pm\/>/.test(xml)) throw new Error('its h:mm AM/PM style');
  // custom number codes: a spreadsheet with some, downloaded as .ods, has them as number styles
  const custom = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Codes', content: { sheets: [{ name: 'S', colWidths: {}, cells: { A1: '1234.5', A2: '-5' },
    formats: { A1: { num: 'custom', code: '0.0,"k"' }, A2: { num: 'custom', code: '0;(0)' } } }] } })).body;
  const b64 = await page.evaluate(async (id) => { const r = await fetch(`/api/files/${id}/export?format=ods`); const a = new Uint8Array(await r.arrayBuffer()); let t = ''; for (const x of a) t += String.fromCharCode(x); return btoa(t); }, custom.id);
  const cx = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('content.xml').async('string');
  if (!/number:display-factor="1000"\/><number:text>k<\/number:text>/.test(cx)) throw new Error('0.0,"k" as a display factor and text');
  if (!/<number:text>\(<\/number:text><number:number [^>]*\/><number:text>\)<\/number:text><style:map style:condition="value\(\)&gt;=0"/.test(cx)) throw new Error('0;(0) as two sections');
});
await step('a cell formatted as a fraction or with a condition shows it so', async () => {
  const f = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Fractions', content: { sheets: [{ name: 'S', colWidths: {}, cells: { A1: '1.5', A2: '-1.25', A3: '150', A4: '50', A5: '12345' },
    formats: { A1: { num: 'custom', code: '# ?/?' }, A2: { num: 'custom', code: '# ?/?;(# ?/?)' }, A3: { num: 'custom', code: '[>100]0;0.00' }, A4: { num: 'custom', code: '[>100]0;0.00' }, A5: { num: 'custom', code: '##0.0E+0' } } }] } })).body;
  await page.goto(`${B}/sheets/${f.id}`);
  await cell('A1').waitFor();
  await until(async () => (await text('A1')) === '1 1/2');
  await expectCells({ A2: '(1 1/4)', A3: '150', A4: '50.00', A5: '12.3E+3' }); // engineering notation: exponents in threes
});
await step('a narrow column keeps its width in the .xlsx download', async () => {
  const f = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Widths', content: { sheets: [{ name: 'S', cells: { A1: 'a', C1: 'c' }, colWidths: { A: 150, C: 60 } }] } })).body;
  const b64 = await page.evaluate(async (id) => { const r = await fetch(`/api/files/${id}/export?format=xlsx`); const a = new Uint8Array(await r.arrayBuffer()); let t = ''; for (const x of a) t += String.fromCharCode(x); return btoa(t); }, f.id);
  const xml = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('xl/worksheets/sheet1.xml').async('string');
  if (!/<col min="3" max="3" width="7.86"/.test(xml)) throw new Error(xml.match(/<cols>.*?<\/cols>/)?.[0] || 'no cols'); // (was 8: read back as Excel's standard width, so lost)
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
