// Spreadsheets against another program: openpyxl, the Python library most programs use to read and write Excel files.
// Random sheets (numbers, text that looks like numbers or formulas, accents, emoji, line breaks, TRUE/FALSE, errors,
// dates and times, formulas, newer Excel functions; bold, italic, underline, strikethrough, colours, fills, wrapping,
// alignment, number formats) go out as .xlsx for openpyxl to read, and openpyxl writes them for Sheets to open. Both
// ways, each cell has the same value, kind and look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { excelFromSheet, sheetFromExcel } from '../src/office/excel.js';

const python = (code, input) => { const r = spawnSync('python3', ['-I', '-c', code], { input, maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(String(r.stderr)); return JSON.parse(r.stdout); };
const hasOpenpyxl = spawnSync('python3', ['-c', 'import openpyxl']).status === 0;

let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
// [what's typed in Sheets, what Excel has: kind and value]
const VALUES = [['42', 'n', 42], ['-3.5', 'n', -3.5], ['0', 'n', 0], ['1e-7', 'n', 1e-7], ['123456789012', 'n', 123456789012], ['0.1', 'n', 0.1],
  ['hello', 's', 'hello'], ['Ωmega naïve', 's', 'Ωmega naïve'], ['中文', 's', '中文'], ['😀 emoji', 's', '😀 emoji'], ['two  spaces', 's', 'two  spaces'],
  ['a&b<c>"d"', 's', 'a&b<c>"d"'], ["'007", 's', '007'], ["'=not a formula", 's', '=not a formula'], ['line\nbreak', 's', 'line\nbreak'],
  ['TRUE', 'b', true], ['FALSE', 'b', false], ['#N/A', 'e', '#N/A'],
  ['2026-11-20', 'd', '2026-11-20T00:00:00'], ['2026-11-20 14:30', 'd', '2026-11-20T14:30:00'],
  ['=1+2', 'f', '=1+2'], ['=SUM(A1:A3)', 'f', '=SUM(A1:A3)'], ['=IF(A1>0,"pos","neg")', 'f', '=IF(A1>0,"pos","neg")'], ['="x"&"y"', 'f', '="x"&"y"'],
  ['=ROUND(PI(),4)', 'f', '=ROUND(PI(),4)'], ['=CONCAT("a",1)', 'f', '=CONCAT("a",1)'], ['=Sheet2!A1', 'f', '=Sheet2!A1'], ['=XLOOKUP(1,{1,2},{"a","b"})', 'f', '=XLOOKUP(1,{1,2},{"a","b"})']];
// [Sheets' format, what Excel has: font, fill, alignment, and a test for the number format]
const FMTS = [[null, {}], [{ b: 1 }, { b: true }], [{ i: 1, color: '#d93025' }, { i: true, color: 'D93025' }], [{ fill: '#fbbc04' }, { fill: 'FBBC04' }],
  [{ u: 1, s: 1 }, { u: true, strike: true }], [{ wrap: 1 }, { wrap: true }], [{ align: 'center' }, { align: 'center' }], [{ align: 'right' }, { align: 'right' }],
  [{ num: 'number', dp: 2 }, { fmt: '0.00' }], [{ num: 'percent', dp: 1 }, { fmt: '0.0%' }], [{ num: 'custom', code: '0.000' }, { fmt: '0.000' }], [{ num: 'currency', cur: 'USD', dp: 2 }, { fmt: '$' }]];

function sheets(n) {
  return Array.from({ length: n }, () => {
    const cells = {}, formats = {}, want = {};
    for (let r = 1; r <= 6; r++) for (const c of 'ABCD') {
      if (rnd() < 0.3) continue;
      const [typed, kind, value] = pick(VALUES);
      const [fmt, look] = kind === 'd' ? [null, {}] : pick(FMTS); // (a date keeps its own date format)
      const key = `${c}${r}`;
      cells[key] = typed;
      if (fmt) formats[key] = fmt;
      want[key] = { kind, value, look };
    }
    return { book: { sheets: [{ name: 'Sheet1', cells, formats }, { name: 'Sheet2', cells: { A1: '7' }, formats: {} }] }, want };
  });
}

// openpyxl's view of each cell of the first sheet: kind (n s b e d f), value, and look.
const READ = `
import sys, json, io, base64, openpyxl, datetime
out = []
for b64 in json.load(sys.stdin):
    ws = openpyxl.load_workbook(io.BytesIO(base64.b64decode(b64))).worksheets[0]
    cells = {}
    for row in ws.iter_rows():
        for c in row:
            if c.value is None: continue
            v = c.value
            if c.data_type == 'f' or (isinstance(v, str) and c.data_type == 'f'): kind = 'f'
            elif isinstance(v, bool): kind = 'b'
            elif isinstance(v, (datetime.datetime, datetime.date)): kind, v = 'd', v.isoformat() if isinstance(v, datetime.datetime) else v.isoformat() + 'T00:00:00'
            elif isinstance(v, (int, float)): kind = 'n'
            elif c.data_type == 'e': kind = 'e'
            else: kind = 's'
            if kind == 'f' and not isinstance(v, str): v = str(getattr(v, 'text', v))
            f, fill, al = c.font, c.fill, c.alignment
            rgb = lambda x: x.rgb[-6:].upper() if x is not None and isinstance(x.rgb, str) and x.rgb not in ('00000000', 'FF000000') else None
            cells[c.coordinate] = {'kind': kind, 'value': v, 'b': bool(f.b), 'i': bool(f.i), 'u': bool(f.u), 'strike': bool(f.strike), 'color': rgb(f.color),
              'fill': rgb(fill.fgColor) if fill is not None and fill.fill_type == 'solid' else None, 'wrap': bool(al.wrap_text), 'align': al.horizontal, 'fmt': c.number_format}
    out.append(cells)
print(json.dumps(out))
`;

function compare(want, got, at) {
  const wrong = [];
  for (const [key, w] of Object.entries(want)) {
    const g = got[key];
    if (!g) { wrong.push(`${at} ${key}: missing`); continue; }
    const gv = g.kind === 'f' ? String(g.value).replace(/_xlfn\.|_xlws\./g, '') : g.value;
    if (g.kind !== w.kind || (w.kind === 'n' ? Math.abs(gv - w.value) > 1e-12 * Math.max(1, Math.abs(w.value)) : gv !== w.value)) wrong.push(`${at} ${key}: ${JSON.stringify(w.value)} (${w.kind}) came as ${JSON.stringify(gv)} (${g.kind})`);
    const L = w.look;
    for (const k of ['b', 'i', 'u', 'strike', 'wrap']) if (!!L[k] !== g[k]) wrong.push(`${at} ${key}: ${k} ${!!L[k]} came as ${g[k]}`);
    if ((L.color || null) !== g.color) wrong.push(`${at} ${key}: colour ${L.color} came as ${g.color}`);
    if ((L.fill || null) !== g.fill) wrong.push(`${at} ${key}: fill ${L.fill} came as ${g.fill}`);
    if ((L.align || null) !== (g.align === 'general' ? null : g.align || null)) wrong.push(`${at} ${key}: align ${L.align} came as ${g.align}`);
    if (L.fmt && !String(g.fmt).includes(L.fmt)) wrong.push(`${at} ${key}: format ${L.fmt} came as ${g.fmt}`);
  }
  return wrong;
}

test('40 random sheets as .xlsx, read by openpyxl: each cell\'s value, kind and look', { skip: !hasOpenpyxl && 'no openpyxl here' }, async () => {
  const list = sheets(40);
  const files = await Promise.all(list.map((s) => excelFromSheet(s.book)));
  const got = python(READ, JSON.stringify(files.map((b) => Buffer.from(b).toString('base64'))));
  const wrong = list.flatMap((s, i) => compare(s.want, got[i], `#${i}`));
  assert.deepEqual(wrong.slice(0, 15), []);
});

test('and 40 written by openpyxl, opened in Sheets: each cell as it would be typed, with its look', { skip: !hasOpenpyxl && 'no openpyxl here' }, async () => {
  const list = sheets(40);
  const WRITE = `
import sys, json, io, base64, openpyxl, datetime
from openpyxl.styles import Font, PatternFill, Alignment
out = []
for want in json.load(sys.stdin):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Sheet1'; wb.create_sheet('Sheet2')['A1'] = 7
    for key, w in want.items():
        c = ws[key]; v = w['value']
        if w['kind'] == 'd': c.value = datetime.datetime.fromisoformat(v); c.number_format = 'yyyy-mm-dd' if v.endswith('T00:00:00') else 'yyyy-mm-dd hh:mm'
        elif w['kind'] == 'e': c.value = v; c.data_type = 'e'
        elif w['kind'] == 's': c.value = v; c.data_type = 's'
        else: c.value = v
        L = w['look']
        c.font = Font(b=L.get('b', False), i=L.get('i', False), u='single' if L.get('u') else None, strike=L.get('strike', False), color=('FF' + L['color']) if L.get('color') else None)
        if L.get('fill'): c.fill = PatternFill('solid', fgColor='FF' + L['fill'])
        if L.get('wrap') or L.get('align'): c.alignment = Alignment(wrap_text=L.get('wrap', False), horizontal=L.get('align'))
        if L.get('fmt') and L['fmt'] != '$': c.number_format = L['fmt']
        if L.get('fmt') == '$': c.number_format = '"$"#,##0.00'
    buf = io.BytesIO(); wb.save(buf); out.append(base64.b64encode(buf.getvalue()).decode())
print(json.dumps(out))
`;
  const files = python(WRITE, JSON.stringify(list.map((s) => s.want)));
  const wrong = [];
  for (const [i, s] of list.entries()) {
    const back = await sheetFromExcel(Buffer.from(files[i], 'base64'));
    const sh = (back.sheets || back)[0];
    for (const [key, w] of Object.entries(s.want)) {
      const typed = s.book.sheets[0].cells[key];
      const got = sh.cells[key] ?? '';
      // (a text that looks like a number or formula comes back marked as text, ' first, as it's typed in Sheets)
      const want = w.kind === 'd' ? typed : w.kind === 'n' ? String(w.value) : typed;
      const same = got === want || (w.kind === 'n' && Number(got) === w.value);
      if (!same) wrong.push(`#${i} ${key}: ${JSON.stringify(want)} came back ${JSON.stringify(got)}`);
      const f = sh.formats?.[key] || {}, L = w.look;
      const look = { b: !!f.b, i: !!f.i, u: !!f.u, strike: !!f.s, wrap: !!f.wrap, color: (f.color || '').replace('#', '').toUpperCase() || null, fill: (f.fill || '').replace('#', '').toUpperCase() || null, align: f.align || null };
      const exp = { b: !!L.b, i: !!L.i, u: !!L.u, strike: !!L.strike, wrap: !!L.wrap, color: L.color || null, fill: L.fill || null, align: L.align || null };
      if (JSON.stringify(look) !== JSON.stringify(exp)) wrong.push(`#${i} ${key}: look ${JSON.stringify(exp)} came back ${JSON.stringify(look)}`);
    }
  }
  assert.deepEqual(wrong.slice(0, 15), []);
});
