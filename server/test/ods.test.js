import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
const { odsFromSheet, sheetFromOds, formulaToOds, formulaFromOds, ODS_MIME, commentsOfOds } = await import('../src/office/ods.js');

test('formulas: Sheets ↔ OpenFormula (references in brackets, other sheets, ";" between arguments, strings left alone)', () => {
  assert.equal(formulaToOds('=SUM(A1:B2,Other!C3)'), 'of:=SUM([.A1:.B2];[$Other.C3])');
  assert.equal(formulaToOds("='My sheet'!$A$1*2"), "of:=[$'My sheet'.$A$1]*2");
  assert.equal(formulaToOds('=IF(A1>1,"a, b; A1","c")'), 'of:=IF([.A1]>1;"a, b; A1";"c")');
  assert.equal(formulaToOds('=SUM({1,2;3,4})'), 'of:=SUM({1;2|3;4})');
  assert.equal(formulaToOds('=LOG10(100)+ATAN2(1,1)'), 'of:=LOG10(100)+ATAN2(1;1)', 'function names with digits are not cells');
  assert.equal(formulaFromOds('of:=SUM([.A1:.B2];[$Other.C3])'), '=SUM(A1:B2,Other!C3)');
  assert.equal(formulaFromOds("of:=[$'My sheet'.$A$1]*2"), "='My sheet'!$A$1*2");
  assert.equal(formulaFromOds('of:=SUM([.A:.A])'), '=SUM(A:A)');
  assert.equal(formulaFromOds('of:=SUM({1;2|3;4})'), '=SUM({1,2;3,4})');
  assert.equal(formulaFromOds('of:=IF([.A1]>1;"x;[.B2]";"y")'), '=IF(A1>1,"x;[.B2]","y")');
  assert.equal(formulaFromOds('oooc:=[.A1]+1'), '=A1+1', 'older OpenOffice files');
});

const book = { sheets: [
  { name: 'Sales', cells: { A1: 'Item', B1: 'Amount', A2: 'Pens', B2: '4.5', A3: 'Ink', B3: '10', A4: 'Total', B4: '=SUM(B2:B3)', C2: '=B2/B4', D1: '2026-11-12', D2: 'TRUE', A6: 'line1\nline2' },
    formats: { A1: { b: 1, i: 1, fill: '#ffeeaa', color: '#cc0000' }, B2: { num: 'currency', cur: 'EUR', dp: 2 }, C2: { num: 'percent', dp: 1 }, B4: { b: 1, bd: 'tb', align: 'right', wrap: 1 } },
    colWidths: { A: 180 }, rowHeights: { 1: 40 }, merges: ['A6:B6'], frozen: { rows: 1, cols: 1 }, notes: { B4: 'Checked by Kim' }, hide: { cols: [4], rows: [7] } },
  { name: 'Other sheet', cells: { A1: "='Sales'!B4*2" } },
] };

test('.ods out: a file LibreOffice recognises, with typed values, formulas, styles and the frozen view', async () => {
  const buf = await odsFromSheet(book);
  const zip = await JSZip.loadAsync(buf);
  assert.equal(Object.keys(zip.files)[0], 'mimetype');
  assert.equal(await zip.file('mimetype').async('string'), ODS_MIME);
  const xml = await zip.file('content.xml').async('string');
  assert.match(xml, /<table:table table:name="Sales">/);
  assert.match(xml, /<table:table table:name="Other sheet">/);
  assert.match(xml, /table:formula="of:=SUM\(\[\.B2:\.B3\]\)"/);
  assert.match(xml, /table:formula="of:=\[\$'Sales'\.B4\]\*2"|table:formula="of:=\[\$&apos;Sales&apos;\.B4\]\*2"/);
  assert.match(xml, /office:value-type="currency" office:value="4\.5" office:currency="EUR"/);
  assert.match(xml, /office:value-type="date" office:date-value="2026-11-12"/);
  assert.match(xml, /office:value-type="boolean" office:boolean-value="true"/);
  assert.match(xml, /table:number-columns-spanned="2" table:number-rows-spanned="1"[^>]*>[\s\S]*?<text:p>line1<\/text:p><text:p>line2<\/text:p>[\s\S]*?<table:covered-table-cell\/>/);
  assert.match(xml, /<office:annotation><text:p>Checked by Kim<\/text:p><\/office:annotation>/);
  assert.match(xml, /<number:currency-style[^>]*><number:currency-symbol>EUR<\/number:currency-symbol>/);
  assert.match(xml, /<number:percentage-style[^>]*><number:number number:decimal-places="1"/);
  assert.match(xml, /fo:background-color="#ffeeaa"[\s\S]*?fo:font-weight="bold" fo:font-style="italic"[^>]*fo:color="#cc0000"/);
  assert.match(xml, /table:visibility="collapse"/);
  assert.match(xml, /style:column-width="4\.763cm"/);
  const settings = await zip.file('settings.xml').async('string');
  assert.match(settings, /config:name="Sales">[\s\S]*HorizontalSplitMode" config:type="short">2[\s\S]*VerticalSplitPosition" config:type="int">1/);
});

test('.ods in: what went out comes back', async () => {
  const [s, o] = (await sheetFromOds(await odsFromSheet(book))).sheets;
  assert.equal(s.name, 'Sales');
  assert.deepEqual(s.cells, book.sheets[0].cells);
  assert.deepEqual(s.formats.A1, { b: 1, i: 1, color: '#cc0000', fill: '#ffeeaa' });
  assert.deepEqual(s.formats.B2, { num: 'currency', cur: 'EUR', dp: 2 });
  assert.deepEqual(s.formats.C2, { num: 'percent', dp: 1 });
  assert.deepEqual(s.formats.B4, { b: 1, wrap: 1, bd: 'tb', align: 'right' });
  assert.deepEqual(s.formats.D1, { num: 'date', ds: 'iso' }, 'a date shows as one');
  assert.deepEqual(s.colWidths, { A: 180 });
  assert.deepEqual(s.rowHeights, { 1: 40 });
  assert.deepEqual(s.merges, ['A6:B6']);
  assert.deepEqual(s.frozen, { rows: 1, cols: 1 });
  assert.deepEqual(s.notes, { B4: 'Checked by Kim' });
  assert.deepEqual(s.hide, { rows: [7], cols: [4] });
  assert.deepEqual(o.cells, { A1: "='Sales'!B4*2" });
});

test('.ods in: repeated cells and rows as LibreOffice writes them; tables named in Sheets go out as ranges', async () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
  const zip = new JSZip();
  zip.file('mimetype', ODS_MIME);
  zip.file('content.xml', `<office:document-content ${NS}><office:body><office:spreadsheet><table:table table:name="Data">
    <table:table-column table:number-columns-repeated="1024"/>
    <table:table-row><table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="3"><text:p>7</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1021"/></table:table-row>
    <table:table-row table:number-rows-repeated="2"><table:table-cell office:value-type="string"><text:p>same</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1023"/></table:table-row>
    <table:table-row table:number-rows-repeated="1048572"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
  </table:table></office:spreadsheet></office:body></office:document-content>`);
  const [s] = (await sheetFromOds(await zip.generateAsync({ type: 'nodebuffer' }))).sheets;
  assert.deepEqual(s.cells, { A1: '7', B1: '7', C1: '7', A2: 'same', A3: 'same' });
  // A Sheets table (a named band) referred to by name goes out as the plain range.
  const t = await odsFromSheet({ sheets: [{ name: 'S', cells: { A1: 'Qty', A2: '2', A3: '3', B1: '=SUM(Orders[Qty])' }, bands: [{ name: 'Orders', range: 'A1:A3', head: '#dddddd' }] }] });
  const xml = await (await JSZip.loadAsync(t)).file('content.xml').async('string');
  assert.match(xml, /of:=SUM\(\[\.A2:\.A3\]\)/);
  assert.match(xml, /fo:background-color="#dddddd"[^/]*\/>(<style:paragraph-properties[^>]*\/>)?<style:text-properties fo:font-weight="bold"/);
  await assert.rejects(sheetFromOds(await new JSZip().file('a', 'b').generateAsync({ type: 'nodebuffer' })), /Not an OpenDocument spreadsheet/);
});

test('.ods: dropdowns as content validations both ways (choices, choices from cells, only these, several, tick boxes), and through LibreOffice', async (t) => {
  const { validationCondition, validationFromCondition } = await import('../src/office/ods.js');
  const JSZip = (await import('jszip')).default;
  const book = { sheets: [{ name: 'My tasks', cells: { A1: 'Task', B1: 'Status', B2: 'Open', D2: 'Low', D3: 'High' }, colWidths: {},
    validations: [{ id: 'v1', range: 'B2:B6', type: 'list', values: ['Open', 'Doing', 'Done "ok"'], strict: true }, { id: 'v2', range: 'C2:C6', type: 'checkbox' },
      { id: 'v3', range: 'E2:E4', type: 'list', source: 'D2:D3', strict: false }, { id: 'v4', range: 'F2:G3', type: 'list', values: ['x', 'y'], multi: true, strict: true },
      { id: 'v5', range: 'H2:H3', type: 'rule', rule: 'number', op: 'gt', a: '0' }] }] };
  const want = JSON.stringify(book.sheets[0].validations.filter((v) => v.type !== 'rule').map(({ id, multi, ...v }) => ({ ...v, ...(multi && { multi: true }) })));
  const show = (b) => JSON.stringify((b.sheets[0].validations || []).map(({ id, ...v }) => v));
  const buf = await odsFromSheet(book);
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.match(xml, /<table:content-validation table:name="val1" table:condition="of:cell-content-is-in-list\(&quot;Open&quot;;&quot;Doing&quot;;&quot;Done &quot;&quot;ok&quot;&quot;&quot;\)"[^>]*table:base-cell-address="'My tasks'.B2"/);
  assert.match(xml, /table:condition="of:cell-content-is-in-list\(\[\$'My tasks'\.\$D\$2:\.\$D\$3\]\)"/, 'choices from cells: those cells');
  assert.match(xml, /<table:table-cell table:content-validation-name="val1"\/?>/, 'an empty cell of the range carries it too');
  assert.equal((xml.match(/content-validation-name="val4"/g) || []).length, 4, 'a two-column range: every cell');
  assert.equal(show(await sheetFromOds(buf)), want, 'back the same (rules aren\'t written)');
  // Other forms of the condition, as other programs write them.
  assert.deepEqual(validationFromCondition('oooc:cell-content-is-in-list("a";"b")', { strict: false }), { type: 'list', values: ['a', 'b'], strict: false });
  assert.deepEqual(validationFromCondition('of:cell-content-is-in-list([$Lists.$A$2:.$A$9])', {}, 'Main'), { type: 'list', source: 'Lists!A2:A9', strict: false });
  assert.equal(validationFromCondition('of:cell-content-is-whole-number() and cell-content()>0'), null);
  assert.equal(validationCondition({ type: 'list', values: [] }, 'S'), null);
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-lo-'));
  try {
    fs.writeFileSync(path.join(dir, 's.ods'), buf);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'ods', '--outdir', path.join(dir, 'out'), path.join(dir, 's.ods')], { stdio: 'ignore', timeout: 120000 });
    assert.equal(show(await sheetFromOds(fs.readFileSync(path.join(dir, 'out', 's.ods')))), want, 'opened and saved by LibreOffice');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('.ods: conditional formatting as LibreOffice keeps it, every kind of rule both ways, and through LibreOffice (.ods and its Excel)', async (t) => {
  const red = { fill: '#fce8e6', color: '#c5221f', bold: true }, green = { fill: '#e6f4ea' };
  const rules = [
    { range: 'A1:A9', when: 'gt', value: '5', ...red }, { range: 'A1:A9', when: 'between', value: '1', value2: '3', ...green },
    { range: 'B1:B9', when: 'contains', value: 'an, x', ...green }, { range: 'B1:B9', when: 'notContains', value: 'q"z', ...red },
    { range: 'B1:B9', when: 'starts', value: 'ch', ...red }, { range: 'B1:B9', when: 'empty', ...green }, { range: 'B1:B9', when: 'notEmpty', ...green },
    { range: 'B1:B9', when: 'error', ...red }, { range: 'B1:B9', when: 'duplicate', ...red }, { range: 'B1:B9', when: 'unique', ...green },
    { range: 'A1:A9', when: 'top', value: '3', ...green }, { range: 'A1:A9', when: 'bottom', value: '2', ...red },
    { range: 'A1:A9', when: 'aboveAvg', ...green }, { range: 'A1:A9', when: 'belowAvg', ...red },
    { range: 'C1:C9', when: 'dateToday', ...red }, { range: 'C1:C9', when: 'datePast7', ...green }, { range: 'C1:C9', when: 'dateThisMonth', ...green },
    { range: 'C1:C9', when: 'datePast', ...red }, { range: 'C1:C9', when: 'dateNext7', ...green }, { range: 'C1:C9', when: 'dateBefore', value: '2026-01-31', ...green }, { range: 'C1:C9', when: 'dateAfter', value: 'today', ...red },
    { range: 'A1:A9', when: 'formula', value: '=MOD(A1,2)=0', ...red },
    { range: 'A1:A9', when: 'bars', bar: '#638ec6' }, { range: 'D1:D9', when: 'scale', scale: ['#f8696b', '#ffeb84', '#63be7b'] }, { range: 'E1:E9', when: 'scale', scale: ['#ffffff', '#63be7b'] },
  ];
  const book = { sheets: [{ name: 'My data', cells: { A1: '3', A2: '8', B1: 'apple', C1: '2026-01-05', D1: '1', E1: '2' }, colWidths: {}, rules: rules.map((r, i) => ({ id: `r${i}`, ...r })) }] };
  const want = rules.map((r) => JSON.stringify(r));
  const show = (b) => (b.sheets[0].rules || []).map(({ id, ...r }) => JSON.stringify(r));
  const buf = await odsFromSheet(book);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('content.xml').async('string');
  assert.match(xml, /<calcext:conditional-format calcext:target-range-address="'My data'\.A1:'My data'\.A9"><calcext:condition calcext:apply-style-name="CF1x1" calcext:value="&gt;5" calcext:base-cell-address="'My data'\.A1"\/>/);
  assert.match(xml, /calcext:value="contains-text\(&quot;an, x&quot;\)"/);
  assert.match(xml, /calcext:value="formula-is\(MOD\(\[\.A1\];2\)=0\)"/);
  assert.match(await zip.file('styles.xml').async('string'), /<style:style style:name="CF1x1" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#fce8e6"\/><style:text-properties fo:color="#c5221f" fo:font-weight="bold"\/><\/style:style>/);
  assert.deepEqual(show(await sheetFromOds(buf)), want);
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { sheetFromExcel } = await import('../src/office/excel.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-lo-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  try {
    fs.writeFileSync(path.join(dir, 's.ods'), buf);
    assert.deepEqual(show(await sheetFromOds(lo('s.ods', 'ods', 'a'))), want, 'opened and saved by LibreOffice (which renames the styles: found by the names they are shown under)');
    assert.deepEqual(show(await sheetFromExcel(lo('s.ods', 'xlsx', 'b'))), want, 'LibreOffice\'s Excel file of it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('.ods: the filter as LibreOffice\'s AutoFilter (values to show worked out from the cells, conditions), rows it hides marked; both ways and through LibreOffice', async (t) => {
  const cells = { A1: 'City', B1: 'Sales', C1: 'Note', D1: 'Score', A2: 'Paris', B2: '10', C2: 'big order', D2: '5', A3: 'Rome', B3: '50', C3: 'x', D3: '9', A4: 'Oslo', B4: '30', C4: 'big one', D4: '1', A5: 'Paris', B5: '70', C5: '', D5: '7', A6: '', B6: '40', C6: 'big', D6: '3', B7: '=B2*2' };
  const filter = { range: 'A1:D6', hidden: { A: ['Rome', ''] }, cond: { B: { op: 'gte', a: '20' }, C: { op: 'contains', a: 'big' }, D: { op: 'notbetween', a: '2', b: '6' } } };
  const buf = await odsFromSheet({ sheets: [{ name: 'My data', cells, colWidths: {}, filter }] });
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.match(xml, /<table:database-range [^>]*table:target-range-address="'My data'\.A1:'My data'\.D7" table:display-filter-buttons="true">/, 'down to the last row with something in it');
  assert.match(xml, /<table:filter-condition table:field-number="0" table:value="Paris" table:operator="="><table:filter-set-item table:value="Paris"\/><table:filter-set-item table:value="Oslo"\/><\/table:filter-condition>/, 'the values to show');
  assert.match(xml, /table:value="20" table:operator="&gt;="\/>/, 'a number without a type (LibreOffice keeps it so)');
  const rows = (xml.match(/<table:table-row[^>]*>/g) || []).map((r) => (/table:visibility="filter"/.test(r) ? 'F' : '.')).join('');
  assert.equal(rows.slice(0, 7), '.FF.FFF', 'the rows it hides (row 7: its city is blank, a hidden value)');
  const back = (await sheetFromOds(buf)).sheets[0];
  assert.deepEqual(back.filter, { ...filter, range: 'A1:D7' });
  assert.equal(back.hide, undefined, 'filtered rows aren\'t rows hidden by hand');
  // Every value of a column hidden: nothing shows, and it comes back so.
  const all = await odsFromSheet({ sheets: [{ name: 'S', cells: { A1: 'H', A2: 'Done', A3: '' , B3: 'x' }, filter: { range: 'A1:B3', hidden: { A: ['Done', ''] } } }] });
  assert.deepEqual((await sheetFromOds(all)).sheets[0].filter.hidden, { A: ['Done', ''] });
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-lo-'));
  try {
    fs.writeFileSync(path.join(dir, 's.ods'), buf);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'ods', '--outdir', path.join(dir, 'out'), path.join(dir, 's.ods')], { stdio: 'ignore', timeout: 120000 });
    const lo = (await sheetFromOds(fs.readFileSync(path.join(dir, 'out', 's.ods')))).sheets[0].filter;
    // (LibreOffice leaves out "is not between": an "or" inside the filter's "and")
    assert.deepEqual(lo, { range: 'A1:D7', hidden: { A: ['Rome', ''] }, cond: { B: { op: 'gte', a: '20' }, C: { op: 'contains', a: 'big' } } });
    fs.writeFileSync(path.join(dir, 'all.ods'), all);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'ods', '--outdir', path.join(dir, 'out'), path.join(dir, 'all.ods')], { stdio: 'ignore', timeout: 120000 });
    assert.deepEqual((await sheetFromOds(fs.readFileSync(path.join(dir, 'out', 'all.ods')))).sheets[0].filter.hidden, { A: ['Done', ''] }, 'nothing shown, through LibreOffice too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('.ods: charts as chart objects drawing from the cells, every kind, both ways and through LibreOffice', async (t) => {
  const cells = { A1: 'Month', B1: 'North', C1: 'South', A2: 'Jan', B2: '10', C2: '7', A3: 'Feb', B3: '12', C3: '9', A4: 'Mar', B4: '15', C4: '11' };
  const types = ['column', 'stackedColumn', 'bar', 'stackedBar', 'line', 'area', 'pie', 'doughnut', 'scatter'];
  const charts = Object.fromEntries(types.map((ty, i) => [`c${i}`, { type: ty, range: 'A1:C4', title: `A ${ty} chart`, x: 300 + (i % 3) * 420, y: 40 + Math.floor(i / 3) * 280, w: 400, h: 250 }]));
  const show = (b) => Object.values(b.sheets[0].charts || {}).map((c) => `${c.type} ${c.range} "${c.title}" @${c.x},${c.y} ${c.w}x${c.h}`);
  const want = show({ sheets: [{ charts }] });
  const buf = await odsFromSheet({ sheets: [{ name: 'Sales data', cells, colWidths: {}, charts: { ...charts, bad: { type: 'column', range: 'nonsense' } } }] });
  const zip = await JSZip.loadAsync(buf);
  assert.equal(zip.file(/^Object \d+\/content\.xml$/).length, 9, 'a chart object each (one without usable cells left out)');
  assert.match(await zip.file('META-INF/manifest.xml').async('string'), /manifest:full-path="Object 1\/" manifest:version="1.3" manifest:media-type="application\/vnd\.oasis\.opendocument\.chart"/);
  const o1 = await zip.file('Object 1/content.xml').async('string');
  assert.match(o1, /<chart:plot-area chart:style-name="pa1" table:cell-range-address="'Sales data'\.A1:'Sales data'\.C4" chart:data-source-has-labels="both">/);
  assert.match(o1, /<chart:series chart:class="chart:bar" chart:values-cell-range-address="'Sales data'\.B2:'Sales data'\.B4" chart:label-cell-address="'Sales data'\.B1">/);
  assert.match(await zip.file('Object 4/content.xml').async('string'), /chart:stacked="true" chart:vertical="true"/, 'stacked bars');
  assert.match(await zip.file('content.xml').async('string'), /<table:table table:name="Sales data"><table:shapes><draw:frame [^>]*draw:name="Chart 1" svg:width="10\.583cm" svg:height="6\.615cm"[^>]*><draw:object draw:notify-on-update-of-ranges="'Sales data'\.A1:'Sales data'\.C4" xlink:href="\.\/Object 1"/);
  assert.deepEqual(show(await sheetFromOds(buf)), want);
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-lo-'));
  try {
    fs.writeFileSync(path.join(dir, 's.ods'), buf);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'ods', '--outdir', path.join(dir, 'out'), path.join(dir, 's.ods')], { stdio: 'ignore', timeout: 120000 });
    assert.deepEqual(show(await sheetFromOds(fs.readFileSync(path.join(dir, 'out', 's.ods')))), want, 'opened and saved by LibreOffice (which splits the ranges)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('.ods: comment threads on cells go out as Calc comments (replies written in) and come back as threads; notes stay notes; also through LibreOffice', async (t) => {
  const data = { sheets: [{ name: 'Sheet1', cells: { A1: 'x', B2: 'y' }, notes: { A1: 'A plain note' } }, { name: 'Two', cells: { C3: '5' } }] };
  const comments = [
    { sheet: 0, cell: 'B2', author: 'Kim Park', at: Date.parse('2026-11-02T10:00:00Z'), text: 'Check\nthis', replies: [{ author: 'Olivia Owner', text: 'OK, done' }, { author: '', text: 'Anon' }] },
    { sheet: 1, cell: 'D9', author: 'Lee', at: Date.parse('2026-11-04T10:00:00Z'), text: 'On an empty cell', replies: [] },
    { sheet: 0, cell: 'A1', author: 'X', text: 'A cell with a note keeps its note', replies: [] },
  ];
  const show = (book, list) => [list.map((c) => [c.sheet, c.cell, c.author, c.text, c.replies.map((r) => `${r.author}:${r.text}`)]), book.sheets.map((s) => s.notes || {})];
  const want = [[[0, 'B2', 'Kim Park', 'Check\nthis', ['Olivia Owner:OK, done', ':Anon']], [1, 'D9', 'Lee', 'On an empty cell', []]], [{ A1: 'A plain note' }, {}]];
  const buf = await odsFromSheet(data, { comments });
  const xml = await (await JSZip.loadAsync(buf)).file('content.xml').async('string');
  assert.match(xml, /<dc:creator>Kim Park<\/dc:creator><dc:date>2026-11-02T10:00:00<\/dc:date><text:p>Check<\/text:p><text:p>this<\/text:p><text:p>Reply \(Olivia Owner\):<\/text:p><text:p> {4}OK, done<\/text:p>/);
  const book = await sheetFromOds(buf);
  assert.deepEqual(show(book, commentsOfOds(book)), want);
  assert.equal(commentsOfOds(book)[0].at, Date.parse('2026-11-02T10:00:00Z'));
  assert.deepEqual(commentsOfOds(await sheetFromOds(await odsFromSheet(data))), [], 'none: none');
  // Excel's old-style copy of a thread (from an .xlsx LibreOffice saved as .ods) is the thread too.
  const xlNote = '[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment.\n\nComment:\n    Is it final?\nReply (Raj):\n    Yes';
  const xl = await sheetFromOds(await odsFromSheet({ sheets: [{ name: 'S', cells: { A1: '1' }, notes: { A1: xlNote } }] }));
  assert.deepEqual(show(xl, commentsOfOds(xl)), [[[0, 'A1', '', 'Is it final?', ['Raj:Yes']]], [{}]]);
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: its part skipped'); return; }
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odscomments-'));
  fs.writeFileSync(path.join(dir, 'c.ods'), buf);
  const lo = (as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, 'c.ods')], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, `c.${as}`)); };
  const again = await sheetFromOds(lo('ods', 'o'));
  assert.deepEqual(show(again, commentsOfOds(again)), want, 'saved again by LibreOffice');
  // Saved as .xlsx by LibreOffice: the thread with replies is still a thread.
  const { sheetFromExcel, commentsOfBook } = await import('../src/office/excel.js');
  const xb = await sheetFromExcel(lo('xlsx', 'x'));
  assert.deepEqual(show(xb, commentsOfBook(xb))[0][0], [0, 'B2', 'Kim Park', 'Check\nthis', ['Olivia Owner:OK, done', ':Anon']]);
  fs.rmSync(dir, { recursive: true, force: true });
});
