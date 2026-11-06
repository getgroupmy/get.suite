import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { get, patch } from '../../api.js';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { jsonFromSheetDoc, applySheetJson } from '../collabsync.js';
import { useAuth } from '../../App.jsx';
import { useToast, PromptModal, ConfirmModal, Menu, Avatar, ContextMenu } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { EditorHeader } from '../editorCommon.jsx';
import { CommentsPanel, useComments } from '../comments.jsx';
import { ChartCard, ChartDialog } from './SheetCharts.jsx';
import { dataRegion, rangeText, parseRange } from './charts.js';
import { applyStructure, adjustKey, sortRange, looksLikeHeader } from './structure.js';
import { SortDialog } from './SheetSort.jsx';
import { RulesDialog } from './SheetRules.jsx';
import { ValidationDialog, ChoicePicker } from './SheetValidation.jsx';
import { validationAt, checkEntry, isTicked } from './validation.js';
import { ruleStyle } from './condformat.js';
import { useUndo, undoKey } from '../useUndo.js';

const SEL_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#8430ce', '#00796b', '#c2185b', '#5f6368'];
const colorFor = (id) => SEL_COLORS[[...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % SEL_COLORS.length];
import { createEvaluator, display, colName, cellKey, parseRef, shiftFormula } from './formula.js';
import { NUMBER_FORMATS, CURRENCIES, decimals, formatNumber, cellStyle, mergeFormat } from './cellformat.js';

const TEXT_COLORS = [['', 'Automatic'], ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#1a73e8', 'Blue'], ['#8430ce', 'Purple'], ['#5f6368', 'Grey']];
const FILLS = [['', 'None'], ['#fce8e6', 'Light red'], ['#fef7e0', 'Light yellow'], ['#e6f4ea', 'Light green'], ['#e8f0fe', 'Light blue'], ['#f3e8fd', 'Light purple'], ['#f1f3f4', 'Light grey']];

const MIN_ROWS = 100;
const DEFAULT_W = 100; // column width in pixels when none is set
const MIN_W = 30, MAX_W = 800;
const MIN_COLS = 26;

function sheetSize(cells) {
  let rows = 0, cols = 0;
  for (const k of Object.keys(cells)) {
    const p = parseRef(k);
    if (p) { rows = Math.max(rows, p.r + 1); cols = Math.max(cols, p.c + 1); }
  }
  return { rows: Math.max(MIN_ROWS, rows + 20), cols: Math.max(MIN_COLS, cols + 5) };
}

export default function SheetEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [file, setFile] = useState(null);
  const [data, setData] = useState(null);
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState({ c: 0, r: 0 });
  const [anchor, setAnchor] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'cell' | 'bar'
  const [draft, setDraft] = useState('');
  const [dialog, setDialog] = useState(null);
  const dataRef = useRef(null);
  const gridRef = useRef();
  const clip = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [others, setOthers] = useState([]);
  const readOnly = file?.role === 'viewer';
  // Comments on cells.
  const [params] = useSearchParams();
  const { threads } = useComments(file?.id);
  const [panel, setPanel] = useState(!!params.get('comment'));
  const [thread, setThread] = useState(params.get('comment'));
  const [pending, setPending] = useState(null);
  const [ctx, setCtx] = useState(null); // right-click menu: { x, y, kind: 'row' | 'col' | 'cell' }
  const closeCtx = useCallback(() => setCtx(null), []);

  // The spreadsheet is shared live (Yjs): everyone's changes arrive cell by cell.
  const [{ ydoc, provider }, setLink] = useState({});
  useEffect(() => {
    let alive = true;
    get(`/files/${id}`).then((f) => {
      if (!alive) return;
      setFile(f);
      document.title = `${f.name} · Sheets`;
      const ydoc = new Y.Doc();
      const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/collab`;
      const provider = new WebsocketProvider(url, f.id, ydoc, { maxBackoffTime: 5000 });
      provider.awareness.setLocalStateField('user', { id: user.id, name: user.name, color: colorFor(user.id) });
      const show = () => { const next = jsonFromSheetDoc(ydoc); dataRef.current = next; setData(next); };
      ydoc.on('update', show);
      provider.on('sync', (synced) => { if (synced) { show(); setStatus('saved'); } });
      provider.on('status', ({ status: st }) => setStatus(st === 'connected' ? (provider.synced ? 'saved' : 'connecting') : st === 'disconnected' ? 'offline' : 'connecting'));
      provider.on('connection-close', (e) => { if (e?.code === 4000) window.location.reload(); }); // a version was restored
      provider.awareness.on('change', () => setOthers([...provider.awareness.getStates().entries()]
        .filter(([cid, st]) => cid !== ydoc.clientID && st.user).map(([cid, st]) => ({ cid, ...st.user, sel: st.sel }))));
      setLink({ ydoc, provider });
    }).catch((e) => { toast(e.message, 'error'); navigate('/drive'); });
    return () => { alive = false; document.title = 'Workspace'; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => () => { provider?.destroy(); ydoc?.destroy(); }, [provider, ydoc]);
  const history = useUndo(ydoc, (d) => d.getArray('sheets'));

  // Tell the others which cell is selected.
  useEffect(() => { provider?.awareness.setLocalStateField('sel', { sheet: active, k: cellKey(sel.c, sel.r) }); }, [provider, active, sel]);

  const sheet = data?.sheets[Math.min(active, (data?.sheets.length || 1) - 1)];
  const cells = sheet?.cells || {};
  const formats = sheet?.formats || {};
  const charts = sheet?.charts || {};
  const colWidths = sheet?.colWidths || {};
  const rules = sheet?.rules || [];
  const validations = sheet?.validations || [];
  const [picker, setPicker] = useState(null); // { key }: the choices of a dropdown cell are open
  const frozen = { rows: sheet?.frozen?.rows || 0, cols: sheet?.frozen?.cols || 0 };
  const [resizing, setResizing] = useState(null); // { c, w } while a column edge is dragged
  const widthOf = (c) => (resizing?.c === c ? resizing.w : colWidths[colName(c)] ?? DEFAULT_W);
  // Frozen rows and columns stay put while scrolling: their offsets, measured from the grid.
  const [stick, setStick] = useState({ top: [], left: [] });
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || (!frozen.rows && !frozen.cols)) { if (stick.top.length || stick.left.length) setStick({ top: [], left: [] }); return; }
    const heads = grid.querySelectorAll('thead th');
    const trs = grid.querySelectorAll('tbody tr');
    const top = Array.from({ length: frozen.rows }, (_, r) => trs[r]?.offsetTop ?? 0);
    const left = Array.from({ length: frozen.cols }, (_, c) => heads[c + 1]?.offsetLeft ?? 0);
    if (top.join() !== stick.top.join() || left.join() !== stick.left.join()) setStick({ top, left });
  });
  const evaluate = useMemo(() => createEvaluator(cells), [cells]);
  const { rows, cols } = useMemo(() => sheetSize(cells), [cells]);

  function commitData(next) {
    if (readOnly || !ydoc) return;
    dataRef.current = next;
    setData(next);
    applySheetJson(ydoc, next); // only the cells that changed go to the others
  }

  function writeCells(updates) {
    if (readOnly) return;
    const cur = dataRef.current;
    const sheets = cur.sheets.map((s, i) => {
      if (i !== active) return s;
      const nextCells = { ...s.cells };
      for (const [k, v] of Object.entries(updates)) { if (v === '' || v == null) delete nextCells[k]; else nextCells[k] = v; }
      return { ...s, cells: nextCells };
    });
    commitData({ ...cur, sheets });
  }

  /** Apply a format change to every selected cell. */
  function writeFormats(change) {
    if (readOnly) return;
    const cur = dataRef.current;
    const sheets = cur.sheets.map((s, i) => {
      if (i !== active) return s;
      const f = { ...(s.formats || {}) };
      for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
        const k = cellKey(c, r);
        const m = mergeFormat(f[k], change);
        if (m) f[k] = m; else delete f[k];
      }
      return { ...s, formats: f };
    });
    commitData({ ...cur, sheets });
  }

  /** Change this sheet's own settings (column widths, frozen panes): fn(sheet) → changes. */
  function writeSheet(fn) {
    if (readOnly) return;
    const cur = dataRef.current;
    commitData({ ...cur, sheets: cur.sheets.map((s, i) => (i === active ? { ...s, ...fn(s) } : s)) });
  }
  const setWidth = (c, w) => writeSheet((s) => ({ colWidths: { ...(s.colWidths || {}), [colName(c)]: Math.round(Math.max(MIN_W, Math.min(MAX_W, w))) } }));
  const setFrozen = (rowsN, colsN) => writeSheet((s) => {
    const f = { rows: rowsN ?? (s.frozen?.rows || 0), cols: colsN ?? (s.frozen?.cols || 0) };
    return { frozen: f.rows || f.cols ? f : null };
  });
  /** Drag a column heading's right edge to resize it; double-click to fit its contents. */
  const startResize = (c) => (e) => {
    if (readOnly || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = widthOf(c);
    const move = (ev) => setResizing({ c, w: Math.max(MIN_W, Math.min(MAX_W, w0 + ev.clientX - x0)) });
    const up = (ev) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setResizing(null);
      if (Math.abs(ev.clientX - x0) > 1) setWidth(c, w0 + ev.clientX - x0);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const fitColumn = (c) => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `13px ${getComputedStyle(gridRef.current || document.body).fontFamily}`;
    let w = ctx.measureText(colName(c)).width;
    for (const [k, raw] of Object.entries(cells)) {
      const p = parseRef(k);
      if (!p || p.c !== c || raw === '') continue;
      const v = evaluate(k);
      const f = formats[k];
      ctx.font = `${f?.b ? 'bold ' : ''}${f?.i ? 'italic ' : ''}13px ${getComputedStyle(gridRef.current || document.body).fontFamily}`;
      w = Math.max(w, ctx.measureText(String(formatNumber(v, f) ?? display(v))).width);
    }
    setWidth(c, w + 18);
  };

  /** Add, change (chart) or remove (id, null) a chart on this sheet. */
  function writeChart(id, chart) {
    if (readOnly) return;
    const cur = dataRef.current;
    const sheets = cur.sheets.map((s, i) => {
      if (i !== active) return s;
      const c = { ...(s.charts || {}) };
      if (chart) c[id] = chart; else delete c[id];
      return { ...s, charts: c };
    });
    commitData({ ...cur, sheets });
  }

  /** A new chart of the selected cells (or, with one cell selected, the data around it), placed to their right. */
  function newChart() {
    const g = anchor ? range : dataRegion(sel, (c, r) => cells[cellKey(c, r)] !== undefined && cells[cellKey(c, r)] !== '');
    const wrap = gridRef.current;
    const td = wrap?.querySelector(`[data-k="${cellKey(Math.min(g.c2 + 1, cols - 1), g.r1)}"]`);
    let x = 160, y = 40;
    if (td && wrap) { const a = td.getBoundingClientRect(), b = wrap.getBoundingClientRect(); x = a.left - b.left + wrap.scrollLeft + 12; y = a.top - b.top + wrap.scrollTop; }
    const cid = (crypto.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^\w]/g, '').slice(0, 20);
    setDialog({ type: 'chart', chart: { id: null, newId: cid, type: 'column', range: rangeText(g), title: '', x: Math.round(x), y: Math.round(y), w: 480, h: 300 } });
  }

  /** Insert or delete rows or columns on this sheet ({ axis, at, count }; count < 0 deletes). */
  function changeStructure(change) {
    if (readOnly) return;
    const cur = dataRef.current;
    commitData({ ...cur, sheets: cur.sheets.map((s, i) => (i === active ? applyStructure(s, change) : s)) });
    // Comments move with their cell; a deleted cell's thread is marked as such.
    for (const t of threads) {
      if ((t.anchor?.sheet || 0) !== active || !t.anchor?.cell || t.anchor.gone) continue;
      const k = adjustKey(t.anchor.cell, change);
      if (k !== t.anchor.cell) patch(`/comments/${file.id}/${t.id}`, { anchor: k ? { ...t.anchor, cell: k } : { ...t.anchor, gone: true } }).catch(() => {});
    }
    setAnchor(null);
    if (change.count < 0) setSel((s) => ({ c: change.axis === 'col' ? Math.min(s.c, change.at) : s.c, r: change.axis === 'row' ? Math.min(s.r, change.at) : s.r }));
    gridRef.current?.focus();
  }

  /** Sort rows of a range by one column. */
  function sortBy({ range: g, by, desc, header }) {
    if (readOnly) return;
    const cur = dataRef.current;
    const sheets = cur.sheets.map((s, i) => (i === active ? { ...s, ...sortRange(s, g, by, { desc, header, value: evaluate }) } : s));
    commitData({ ...cur, sheets });
    toast(`Sorted rows ${g.r1 + (header ? 2 : 1)}–${g.r2 + 1} by column ${colName(by)}`);
    gridRef.current?.focus();
  }
  /** The cells a sort applies to: the selection, or with one cell selected, the table around it. */
  const sortTarget = () => (anchor ? range : dataRegion(sel, (c, r) => cells[cellKey(c, r)] !== undefined && cells[cellKey(c, r)] !== ''));
  const quickSort = (desc) => { const g = sortTarget(); sortBy({ range: g, by: sel.c, desc, header: looksLikeHeader(g, evaluate) }); };

  const range = anchor ? {
    c1: Math.min(anchor.c, sel.c), c2: Math.max(anchor.c, sel.c), r1: Math.min(anchor.r, sel.r), r2: Math.max(anchor.r, sel.r),
  } : { c1: sel.c, c2: sel.c, r1: sel.r, r2: sel.r };
  const inRange = (c, r) => c >= range.c1 && c <= range.c2 && r >= range.r1 && r <= range.r2;

  function move(dc, dr, extend = false) {
    if (extend) { if (!anchor) setAnchor(sel); } else setAnchor(null);
    setSel((s) => {
      const n = { c: Math.max(0, Math.min(cols - 1, s.c + dc)), r: Math.max(0, Math.min(rows - 1, s.r + dr)) };
      requestAnimationFrame(() => gridRef.current?.querySelector(`[data-k="${cellKey(n.c, n.r)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      return n;
    });
  }

  function startEdit(initial, where = 'cell') {
    if (readOnly) return;
    setEditing(where);
    setDraft(initial ?? cells[cellKey(sel.c, sel.r)] ?? '');
  }

  /** Save what was typed. A value a strict dropdown doesn't allow: kept for fixing (keep) or dropped. */
  function commitEdit(dc = 0, dr = 0, keep = false) {
    const key = cellKey(sel.c, sel.r);
    const check = checkEntry(validationAt(validations, key), draft);
    if (check.error) { toast(check.error, 'error'); if (!keep) cancelEdit(); return; }
    writeCells({ [key]: check.value });
    setEditing(null);
    move(dc, dr);
    gridRef.current?.focus();
  }

  function cancelEdit() { setEditing(null); gridRef.current?.focus(); }
  const toggleTick = (key) => writeCells({ [key]: isTicked(evaluate(key)) ? 'FALSE' : 'TRUE' });
  /** The different values already in a range (for a new dropdown's choices). */
  const existingValues = (text) => {
    const g = parseRange(text);
    if (!g) return [];
    const out = new Set();
    for (let r = g.r1; r <= Math.min(g.r2, g.r1 + 5000); r++) for (let c = g.c1; c <= g.c2; c++) {
      const raw = cells[cellKey(c, r)];
      if (raw === undefined || raw === '' || String(raw).startsWith('=')) continue;
      out.add(String(raw).trim());
      if (out.size >= 200) return [...out];
    }
    return [...out];
  };

  function onGridKey(e) {
    if (editing) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    const u = undoKey(e);
    if (u) { e.preventDefault(); if (!readOnly) history[u](); return; }
    if (e.altKey && k === 'ArrowDown' && validationAt(validations, cellKey(sel.c, sel.r))?.type === 'list') { e.preventDefault(); if (!readOnly) setPicker({ key: cellKey(sel.c, sel.r) }); return; }
    if (k === 'ArrowUp') { e.preventDefault(); move(0, -1, e.shiftKey); }
    else if (k === 'ArrowDown') { e.preventDefault(); move(0, 1, e.shiftKey); }
    else if (k === 'ArrowLeft') { e.preventDefault(); move(-1, 0, e.shiftKey); }
    else if (k === 'ArrowRight') { e.preventDefault(); move(1, 0, e.shiftKey); }
    else if (k === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); }
    else if (k === ' ' && !mod && validationAt(validations, cellKey(sel.c, sel.r))?.type === 'checkbox') { e.preventDefault(); if (!readOnly) toggleTick(cellKey(sel.c, sel.r)); }
    else if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(); }
    else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      const u = {};
      for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) u[cellKey(c, r)] = '';
      writeCells(u);
    } else if (mod && !e.shiftKey && ['b', 'i', 'u'].includes(k.toLowerCase())) {
      e.preventDefault();
      const key = k.toLowerCase();
      writeFormats({ [key]: !formats[cellKey(sel.c, sel.r)]?.[key] });
    } else if (mod && k.toLowerCase() === 'a') { e.preventDefault(); setAnchor({ c: 0, r: 0 }); setSel({ c: cols - 1, r: rows - 1 }); }
    else if (mod && e.altKey && e.code === 'KeyM') { e.preventDefault(); startComment(); }
    else if (!mod && !e.altKey && k.length === 1) { e.preventDefault(); startEdit(k); }
  }

  function onCopy(e) {
    if (editing) return;
    e.preventDefault();
    const raws = [];
    const fmts = [];
    const lines = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const rawRow = [], vals = [], fmtRow = [];
      for (let c = range.c1; c <= range.c2; c++) {
        const k = cellKey(c, r);
        rawRow.push(cells[k] ?? '');
        fmtRow.push(formats[k] || null);
        vals.push(formatNumber(evaluate(k), formats[k]) ?? display(evaluate(k)));
      }
      raws.push(rawRow);
      fmts.push(fmtRow);
      lines.push(vals.join('\t'));
    }
    const text = lines.join('\n');
    clip.current = { text, raws, fmts, origin: { c: range.c1, r: range.r1 } };
    e.clipboardData.setData('text/plain', text);
  }

  function onCut(e) {
    if (editing || readOnly) return;
    onCopy(e);
    const u = {};
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) u[cellKey(c, r)] = '';
    writeCells(u);
  }

  function onPaste(e) {
    if (editing || readOnly) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r/g, '').replace(/\n$/, '');
    const u = {};
    if (clip.current && clip.current.text === text) {
      const { raws, fmts, origin } = clip.current;
      raws.forEach((row, ri) => row.forEach((raw, ci) => {
        u[cellKey(sel.c + ci, sel.r + ri)] = shiftFormula(raw, sel.c - origin.c, sel.r - origin.r);
      }));
      // Formats come along when copying inside Sheets.
      const cur = dataRef.current;
      const sheets = cur.sheets.map((s, i) => {
        if (i !== active) return s;
        const f = { ...(s.formats || {}) };
        fmts.forEach((row, ri) => row.forEach((fm, ci) => { const k = cellKey(sel.c + ci, sel.r + ri); if (fm) f[k] = fm; else delete f[k]; }));
        return { ...s, formats: f };
      });
      dataRef.current = { ...cur, sheets };
    } else {
      text.split('\n').forEach((line, ri) => line.split('\t').forEach((v, ci) => { u[cellKey(sel.c + ci, sel.r + ri)] = v; }));
    }
    writeCells(u);
  }

  function exportCsv() {
    let maxR = 0, maxC = 0;
    for (const k of Object.keys(cells)) { const p = parseRef(k); if (p) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
    const out = [];
    for (let r = 0; r <= maxR; r++) {
      const row = [];
      for (let c = 0; c <= maxC; c++) {
        const v = display(evaluate(cellKey(c, r)));
        row.push(/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      }
      out.push(row.join(','));
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out.join('\n')], { type: 'text/csv' }));
    a.download = `${file.name} - ${sheet.name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importCsv() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.onchange = async () => {
      const text = await input.files[0].text();
      const u = {};
      parseCsv(text).forEach((row, r) => row.forEach((v, c) => { if (v !== '') u[cellKey(c, r)] = v; }));
      const cur = dataRef.current;
      const name = input.files[0].name.replace(/\.csv$/i, '').slice(0, 30) || 'Imported';
      commitData({ ...cur, sheets: [...cur.sheets, { name, cells: u, colWidths: {} }] });
      setActive(cur.sheets.length);
    };
    input.click();
  }

  if (!data) return <div className="editor-page"><EditorHeader icon="sheet" file={null} status="saved" /></div>;

  const selKey = cellKey(sel.c, sel.r);
  const people = [...new Map(others.map((p) => [p.id, p])).values()].filter((p) => p.id !== user.id);
  // Other people's selected cells on this sheet: outlined in their colour.
  const theirs = new Map(others.filter((p) => p.id !== user.id && p.sel?.sheet === active).map((p) => [p.sel.k, p]));
  const selValue = evaluate(selKey);
  const openThreads = threads.filter((t) => !t.resolved);
  const sheetName = (i) => data.sheets[i]?.name || `Sheet${i + 1}`;
  // Cells on this sheet with open comments: the newest thread of each.
  const commented = new Map(openThreads.filter((t) => (t.anchor?.sheet || 0) === active && !t.anchor?.gone).map((t) => [t.anchor.cell, t.id]));
  const goToCell = (t) => {
    const p = parseRef(t.anchor?.cell || '');
    if (!p || t.anchor.gone) return;
    const s = t.anchor.sheet || 0;
    if (s !== active && s < data.sheets.length) setActive(s);
    setAnchor(null);
    setSel({ c: p.c, r: p.r });
    requestAnimationFrame(() => gridRef.current?.querySelector(`[data-k="${t.anchor.cell}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  };
  const startComment = () => {
    if (readOnly) return;
    setPanel(true);
    setPending({ anchor: { sheet: active, cell: selKey }, label: data.sheets.length > 1 ? `${sheetName(active)} ${selKey}` : selKey,
      onCreated: () => setPending(null), onCancel: () => setPending(null) });
  };
  // Right-click menus: rows, columns, sorting.
  const nr = range.r2 - range.r1 + 1, nc = range.c2 - range.c1 + 1;
  const rowItems = [
    { label: `Insert ${nr > 1 ? `${nr} rows` : '1 row'} above`, icon: 'plus', onClick: () => changeStructure({ axis: 'row', at: range.r1, count: nr }) },
    { label: `Insert ${nr > 1 ? `${nr} rows` : '1 row'} below`, icon: 'plus', onClick: () => changeStructure({ axis: 'row', at: range.r2 + 1, count: nr }) },
    { label: nr > 1 ? `Delete rows ${range.r1 + 1}–${range.r2 + 1}` : `Delete row ${range.r1 + 1}`, icon: 'trash', danger: true, onClick: () => changeStructure({ axis: 'row', at: range.r1, count: -nr }) },
  ];
  const colItems = [
    { label: `Insert ${nc > 1 ? `${nc} columns` : '1 column'} left`, icon: 'plus', onClick: () => changeStructure({ axis: 'col', at: range.c1, count: nc }) },
    { label: `Insert ${nc > 1 ? `${nc} columns` : '1 column'} right`, icon: 'plus', onClick: () => changeStructure({ axis: 'col', at: range.c2 + 1, count: nc }) },
    { label: nc > 1 ? `Delete columns ${colName(range.c1)}–${colName(range.c2)}` : `Delete column ${colName(range.c1)}`, icon: 'trash', danger: true, onClick: () => changeStructure({ axis: 'col', at: range.c1, count: -nc }) },
  ];
  const sortItems = [
    { label: `Sort A → Z by column ${colName(sel.c)}`, onClick: () => quickSort(false) },
    { label: `Sort Z → A by column ${colName(sel.c)}`, onClick: () => quickSort(true) },
    { label: 'Sort range…', onClick: () => setDialog({ type: 'sort' }) },
  ];
  const freezeRows = [
    { label: range.r2 === 0 ? 'Freeze the first row' : `Freeze rows 1–${range.r2 + 1}`, onClick: () => setFrozen(Math.min(range.r2 + 1, 50), null), disabled: frozen.rows === range.r2 + 1 },
    frozen.rows > 0 && { label: 'Unfreeze rows', onClick: () => setFrozen(0, null) },
  ];
  const freezeCols = [
    { label: range.c2 === 0 ? 'Freeze the first column' : `Freeze columns A–${colName(range.c2)}`, onClick: () => setFrozen(null, Math.min(range.c2 + 1, 26)), disabled: frozen.cols === range.c2 + 1 },
    frozen.cols > 0 && { label: 'Unfreeze columns', onClick: () => setFrozen(null, 0) },
    { label: `Fit column ${colName(range.c1)} to its contents`, onClick: () => fitColumn(range.c1) },
  ];
  rowItems.push('-', ...freezeRows);
  colItems.push('-', ...freezeCols);
  const ctxItems = ctx?.kind === 'row' ? rowItems : ctx?.kind === 'col' ? [...colItems, '-', ...sortItems] : [...rowItems, '-', ...colItems, '-', ...sortItems];
  /** Open the menu at the mouse, or (keyboard: the menu key, Shift+F10) at the selected cell. */
  const openMenu = (e, kind) => {
    if (readOnly) return;
    e.preventDefault();
    let { clientX: x, clientY: y } = e;
    if (!x && !y) { const td = gridRef.current?.querySelector(`[data-k="${cellKey(sel.c, sel.r)}"]`)?.getBoundingClientRect(); x = td ? td.left + 20 : 200; y = td ? td.bottom : 200; }
    setCtx({ x, y, kind });
  };
  const frozenClass = (c, r) => `${r < frozen.rows ? 'frozen-r' : ''} ${c < frozen.cols ? 'frozen-c' : ''} ${r === frozen.rows - 1 ? 'freeze-edge-b' : ''} ${c === frozen.cols - 1 ? 'freeze-edge-r' : ''}`;
  const stickyStyle = (c, r) => (r < frozen.rows || c < frozen.cols ? { ...(r < frozen.rows && { top: stick.top[r] }), ...(c < frozen.cols && { left: stick.left[c] }) } : null);
  const isWholeRows = anchor && range.c1 === 0 && range.c2 === cols - 1;
  const isWholeCols = anchor && range.r1 === 0 && range.r2 === rows - 1;
  /** Clicking a row or column heading selects it (Shift extends). A right-click inside the selection keeps it. */
  const pickRow = (r, e) => { if (editing) commitEdit(0, 0); if (e.shiftKey && anchor) setSel({ c: 0, r }); else { setAnchor({ c: cols - 1, r }); setSel({ c: 0, r }); } gridRef.current?.focus(); };
  const pickCol = (c, e) => { if (editing) commitEdit(0, 0); if (e.shiftKey && anchor) setSel({ c, r: 0 }); else { setAnchor({ c, r: rows - 1 }); setSel({ c, r: 0 }); } gridRef.current?.focus(); };

  const where = (t) => `${data.sheets.length > 1 ? `${sheetName(t.anchor?.sheet || 0)} ` : ''}${t.anchor?.cell || ''}${t.anchor?.gone ? ' (deleted)' : ''}`;

  return (
    <div className="editor-page sheet-page">
      <EditorHeader
        icon="sheet" file={file} status={status}
        onRename={async (name) => setFile(await patch(`/files/${id}`, { name }))}
        onShare={() => setDialog({ type: 'share' })}
        extra={<>
          <button type="button" className={`btn small ${panel ? 'primary' : ''}`} aria-pressed={panel} onClick={() => { if (panel && pending) setPending(null); setPanel(!panel); }} title="Comments">
            <Icon name="chat" size={16} /> {openThreads.length || ''}<span className="sr-only">Comments</span>
          </button>
          {people.length > 0 && (
          <div className="coeditors" aria-label={`Also here: ${people.map((p) => p.name).join(', ')}`}>
            {people.slice(0, 4).map((p) => <span key={p.id} className="coeditor" style={{ '--c': p.color }} title={`${p.name} is here`}><Avatar name={p.name} size={28} /></span>)}
            {people.length > 4 && <span className="muted small">+{people.length - 4}</span>}
          </div>
          )}
        </>}
        menu={[
          { label: 'Download as Excel (.xlsx)', icon: 'download', onClick: () => { window.location.href = `/api/files/${id}/export`; } },
          { label: 'Download sheet as CSV', icon: 'download', onClick: exportCsv },
          !readOnly && { label: 'Import CSV as new sheet', icon: 'upload', onClick: importCsv },
        ]}
      />
      {status === 'offline' && <div className="banner warn">You're offline. Keep editing: your changes are kept here and sync when the connection is back.</div>}
      {readOnly && <div className="banner">View only. Ask {file.owner_name} for edit access.</div>}
      {!readOnly && <FormatBar fmt={formats[selKey] || {}} onChange={(change) => { writeFormats(change); gridRef.current?.focus(); }} onComment={startComment} onChart={newChart} onSort={() => setDialog({ type: 'sort' })} onRules={() => setDialog({ type: 'rules' })} onValidation={() => setDialog({ type: 'validation' })} history={history} />}
      <div className="formula-bar">
        <span className="cell-name">{anchor ? `${cellKey(range.c1, range.r1)}:${cellKey(range.c2, range.r2)}` : selKey}</span>
        <span className="fx">fx</span>
        <input
          aria-label="Cell contents" readOnly={readOnly}
          value={editing ? draft : cells[selKey] ?? ''}
          onFocus={() => !editing && startEdit(undefined, 'bar')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(0, 1, true); }
            if (e.key === 'Escape') cancelEdit();
          }}
          onBlur={() => editing === 'bar' && commitEdit(0, 0)}
        />
        {selValue && typeof selValue === 'object' && selValue.error && <span className="error small">{describeError(selValue.error)}</span>}
      </div>
      <div className="sheet-body">
      <div className="grid-wrap" ref={gridRef} onContextMenu={(e) => { if (e.target === e.currentTarget) openMenu(e, 'cell'); }} tabIndex={0} onKeyDown={onGridKey} onCopy={onCopy} onCut={onCut} onPaste={onPaste}>
        <table className="grid" role="grid" aria-label={sheet.name}>
          <thead>
            <tr><th className="corner" />{Array.from({ length: cols }, (_, c) => (
              <th key={c} className={`${c >= range.c1 && c <= range.c2 ? 'hl' : ''} ${c < frozen.cols ? 'frozen-c' : ''} ${c === frozen.cols - 1 ? 'freeze-edge-r' : ''}`}
                style={{ width: widthOf(c), minWidth: widthOf(c), maxWidth: widthOf(c), ...(c < frozen.cols && { left: stick.left[c] }) }}
                onMouseDown={(e) => { if (e.button === 0) pickCol(c, e); }}
                onContextMenu={(e) => { if (!(isWholeCols && c >= range.c1 && c <= range.c2)) pickCol(c, { shiftKey: false }); openMenu(e, 'col'); }}>
                {colName(c)}
                {!readOnly && <span className="col-resize" role="separator" aria-orientation="vertical" aria-label={`Resize column ${colName(c)}`} title="Drag to resize, double-click to fit"
                  onPointerDown={startResize(c)} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); fitColumn(c); }} />}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                <th className={`${r >= range.r1 && r <= range.r2 ? 'hl' : ''} ${r < frozen.rows ? 'frozen-r' : ''} ${r === frozen.rows - 1 ? 'freeze-edge-b' : ''}`}
                  style={r < frozen.rows ? { top: stick.top[r] } : undefined} onMouseDown={(e) => { if (e.button === 0) pickRow(r, e); }}
                  onContextMenu={(e) => { if (!(isWholeRows && r >= range.r1 && r <= range.r2)) pickRow(r, { shiftKey: false }); openMenu(e, 'row'); }}>{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const k = cellKey(c, r);
                  const isSel = c === sel.c && r === sel.r;
                  if (isSel && editing === 'cell') {
                    return (
                      <td key={k} data-k={k} className={`sel editing ${frozenClass(c, r)}`} style={{ maxWidth: widthOf(c), ...stickyStyle(c, r) }}>
                        <input autoFocus value={draft} aria-label={`Edit ${k}`} onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitEdit(0, e.shiftKey ? -1 : 1, true); }
                            else if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? -1 : 1, 0, true); }
                            else if (e.key === 'Escape') cancelEdit();
                          }}
                          onBlur={() => editing === 'cell' && commitEdit(0, 0)} />
                      </td>
                    );
                  }
                  const raw = cells[k];
                  const v = raw === undefined ? null : evaluate(k);
                  const isErr = v && typeof v === 'object';
                  const fmt = formats[k];
                  const vd = validations.length ? validationAt(validations, k) : null;
                  return (
                    <td key={k} data-k={k} style={{ maxWidth: widthOf(c), ...stickyStyle(c, r), ...cellStyle(fmt), ...(rules.length && ruleStyle(rules, k, v)), ...(theirs.has(k) && { boxShadow: `${isSel ? 'inset 0 0 0 2px var(--accent), ' : ''}inset 0 0 0 ${isSel ? 4 : 2}px ${theirs.get(k).color}` }) }}
                      title={theirs.has(k) ? `${theirs.get(k).name} is here` : commented.has(k) ? 'Has comments' : undefined}
                      className={`${frozenClass(c, r)} ${vd ? `has-${vd.type}` : ''} ${commented.has(k) ? 'commented' : ''} ${isSel ? 'sel' : ''} ${inRange(c, r) && anchor ? 'range' : ''} ${typeof v === 'number' ? 'num' : ''} ${isErr ? 'err' : ''}`}
                      onContextMenu={(e) => { if (!inRange(c, r)) { setAnchor(null); setSel({ c, r }); } openMenu(e, 'cell'); }}
                      onMouseDown={(e) => {
                        if (e.button !== 0 && inRange(c, r)) return; // a right-click keeps the selection
                        if (editing) commitEdit(0, 0);
                        if (e.shiftKey) { if (!anchor) setAnchor(sel); } else setAnchor(null);
                        setSel({ c, r });
                      }}
                      onMouseEnter={(e) => { if (e.buttons === 1 && !editing) { if (!anchor) setAnchor(sel); setSel({ c, r }); } }}
                      onClick={() => { if (commented.has(k)) { setThread(commented.get(k)); setPanel(true); } }}
                      onDoubleClick={() => startEdit()}>
                      {vd?.type === 'checkbox'
                        ? <input type="checkbox" className="cell-check" tabIndex={-1} checked={isTicked(v)} disabled={readOnly} aria-label={`Tick ${k}`} onChange={() => toggleTick(k)} onDoubleClick={(e) => e.stopPropagation()} />
                        : formatNumber(v, fmt) ?? display(v)}
                      {vd?.type === 'list' && !readOnly && (
                        <button type="button" className="cell-drop" tabIndex={-1} aria-label={`Choices for ${k}`}
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (editing) commitEdit(0, 0); setAnchor(null); setSel({ c, r }); setPicker({ key: k }); }}>▾</button>
                      )}
                      {commented.has(k) && <span className="cell-comment" aria-hidden="true" />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="chart-layer">
          {Object.entries(charts).map(([cid, ch]) => (
            <ChartCard key={cid} chart={ch} value={evaluate} canEdit={!readOnly}
              onChange={(next) => writeChart(cid, next)}
              onEdit={() => setDialog({ type: 'chart', chart: { ...ch, id: cid } })}
              onDelete={() => writeChart(cid, null)} />
          ))}
        </div>
      </div>
      {panel && <CommentsPanel fileId={file.id} threads={threads} canEdit={!readOnly} active={thread} setActive={setThread} pending={pending}
        onShow={goToCell} labelOf={where} onClose={() => { setPending(null); setPanel(false); }} />}
      </div>
      <div className="sheet-tabs">
        {!readOnly && (
          <button className="icon-btn" aria-label="Add sheet" onClick={() => {
            const cur = dataRef.current;
            commitData({ ...cur, sheets: [...cur.sheets, { name: `Sheet${cur.sheets.length + 1}`, cells: {}, colWidths: {} }] });
            setActive(cur.sheets.length);
          }}><Icon name="plus" size={18} /></button>
        )}
        {data.sheets.map((s, i) => (
          <div key={i} className={`sheet-tab ${i === active ? 'on' : ''}`}>
            <button onClick={() => { setActive(i); setSel({ c: 0, r: 0 }); setAnchor(null); }}>{s.name}</button>
            {i === active && !readOnly && (
              <Menu align="left" trigger={(p) => <button className="tab-menu" aria-label={`Options for ${s.name}`} {...p}>▾</button>} items={[
                { label: 'Rename', icon: 'edit', onClick: () => setDialog({ type: 'rename-sheet', index: i }) },
                data.sheets.length > 1 && { label: 'Delete', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete-sheet', index: i }) },
              ]} />
            )}
          </div>
        ))}
      </div>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} label={ctx.kind === 'row' ? 'Row actions' : ctx.kind === 'col' ? 'Column actions' : 'Cell actions'} onClose={closeCtx} />}
      {dialog?.type === 'rules' && (
        <RulesDialog rules={rules} defaultRange={anchor ? rangeText(range) : rangeText(dataRegion(sel, (c, r) => cells[cellKey(c, r)] !== undefined && cells[cellKey(c, r)] !== ''))}
          onChange={(next) => writeSheet(() => ({ rules: next.length ? next : null }))} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      )}
      {dialog?.type === 'validation' && (
        <ValidationDialog validations={validations} existing={existingValues}
          defaultRange={anchor ? rangeText(range) : rangeText({ c1: sel.c, c2: sel.c, r1: sel.r, r2: sel.r })}
          onChange={(next) => writeSheet(() => ({ validations: next.length ? next : null }))} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      )}
      {picker && (() => {
        const vd = validationAt(validations, picker.key);
        const td = gridRef.current?.querySelector(`[data-k="${picker.key}"]`);
        if (!vd || vd.type !== 'list' || !td) return null;
        const done = () => { setPicker(null); gridRef.current?.focus(); };
        return <ChoicePicker anchor={td} values={vd.values || []} current={cells[picker.key] ?? ''} onClose={done} onPick={(x) => { writeCells({ [picker.key]: x }); done(); }} />;
      })()}
      {dialog?.type === 'sort' && (() => { const g = sortTarget(); return (
        <SortDialog initial={{ range: g, by: sel.c }} header={looksLikeHeader(g, evaluate)} value={evaluate} onSort={sortBy} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      ); })()}
      {dialog?.type === 'chart' && (
        <ChartDialog initial={dialog.chart} value={evaluate} onClose={() => { setDialog(null); gridRef.current?.focus(); }}
          onSave={({ id: cid, newId, ...ch }) => writeChart(cid || newId, ch)} />
      )}
      {dialog?.type === 'share' && <ShareDialog file={file} onClose={() => setDialog(null)} />}
      {dialog?.type === 'rename-sheet' && (
        <PromptModal title="Rename sheet" label="Sheet name" initial={data.sheets[dialog.index].name} onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const cur = dataRef.current;
            commitData({ ...cur, sheets: cur.sheets.map((s, i) => (i === dialog.index ? { ...s, name: name.slice(0, 50) } : s)) });
          }} />
      )}
      {dialog?.type === 'delete-sheet' && (
        <ConfirmModal title="Delete sheet?" message={`“${data.sheets[dialog.index].name}” and all its data will be deleted.`} onClose={() => setDialog(null)}
          onConfirm={async () => {
            const cur = dataRef.current;
            commitData({ ...cur, sheets: cur.sheets.filter((_, i) => i !== dialog.index) });
            setActive(0);
          }} />
      )}
    </div>
  );
}

function describeError(code) {
  return {
    '#DIV/0!': 'Division by zero', '#REF!': 'Invalid cell reference', '#NAME?': 'Unknown function or name',
    '#VALUE!': 'Wrong type of value', '#CIRC!': 'Circular reference', '#NUM!': 'Invalid number', '#ERROR!': 'Formula parse error', '#N/A': 'Value not found',
  }[code] || code;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Formatting for the selected cells: bold, italic, underline, colours, alignment, number format. */
function FormatBar({ fmt, onChange, onComment, onChart, onSort, onRules, onValidation, history }) {
  const keep = (e) => e.preventDefault(); // buttons don't take focus from the grid
  const Toggle = ({ k, label, title, children }) => (
    <button type="button" className={`tb ${fmt[k] ? 'on' : ''}`} aria-pressed={!!fmt[k]} aria-label={label} title={title} onMouseDown={keep} onClick={() => onChange({ [k]: !fmt[k] })}>{children}</button>
  );
  const align = fmt.align || 'auto';
  return (
    <div className="sheet-toolbar" role="toolbar" aria-label="Cell formatting">
      <button type="button" className="tb" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.canUndo} onMouseDown={keep} onClick={history.undo}>↶</button>
      <button type="button" className="tb" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!history.canRedo} onMouseDown={keep} onClick={history.redo}>↷</button>
      <span className="sep" />
      <Toggle k="b" label="Bold" title="Bold (Ctrl+B)"><b>B</b></Toggle>
      <Toggle k="i" label="Italic" title="Italic (Ctrl+I)"><i>I</i></Toggle>
      <Toggle k="u" label="Underline" title="Underline (Ctrl+U)"><u>U</u></Toggle>
      <span className="sep" />
      <label className="tb-color" title="Text colour"><span className="color-a" aria-hidden="true">A<span className="color-bar" style={{ background: fmt.color || 'currentColor' }} /></span>
        <select aria-label="Text colour" value={fmt.color || ''} onChange={(e) => onChange({ color: e.target.value })}>
          {TEXT_COLORS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
        </select></label>
      <label className="tb-color" title="Fill colour"><span className="fill-swatch" aria-hidden="true" style={{ background: fmt.fill || 'transparent' }} />
        <select aria-label="Fill colour" value={fmt.fill || ''} onChange={(e) => onChange({ fill: e.target.value })}>
          {FILLS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
        </select></label>
      <span className="sep" />
      {[['left', 'Align left', '⯇'], ['center', 'Centre', '≡'], ['right', 'Align right', '⯈']].map(([a, label]) => (
        <button key={a} type="button" className={`tb ${align === a ? 'on' : ''}`} aria-pressed={align === a} aria-label={label} title={label} onMouseDown={keep}
          onClick={() => onChange({ align: align === a ? null : a })}><AlignGlyph to={a} /></button>
      ))}
      <span className="sep" />
      <select className="tb-select" aria-label="Number format" title="Number format" value={fmt.num || ''} onChange={(e) => onChange({ num: e.target.value, dp: null })}>
        {NUMBER_FORMATS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      {fmt.num === 'currency' && (
        <select className="tb-select" aria-label="Currency" value={fmt.cur || 'MYR'} onChange={(e) => onChange({ cur: e.target.value, dp: null })}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      {fmt.num && <>
        <button type="button" className="tb" aria-label="Fewer decimals" title="Fewer decimals" onMouseDown={keep} onClick={() => onChange({ dp: Math.max(0, decimals(fmt) - 1) })}>.0←</button>
        <button type="button" className="tb" aria-label="More decimals" title="More decimals" onMouseDown={keep} onClick={() => onChange({ dp: Math.min(10, decimals(fmt) + 1) })}>.00→</button>
      </>}
      <span className="sep" />
      <button type="button" className="tb" aria-label="Clear formatting" title="Clear formatting" onMouseDown={keep}
        onClick={() => onChange({ b: null, i: null, u: null, color: null, fill: null, align: null, num: null })}>Tx</button>
      <span className="sep" />
      <button type="button" className="tb labelled" aria-label="Conditional formatting" title="Colour cells by their value" onMouseDown={keep} onClick={onRules}><RulesGlyph /> Rules</button>
      <button type="button" className="tb labelled" aria-label="Dropdowns and tick boxes" title="Dropdown lists and tick boxes in cells" onMouseDown={keep} onClick={onValidation}>▾ Dropdown</button>
      <button type="button" className="tb labelled" aria-label="Sort range" title="Sort rows by a column" onMouseDown={keep} onClick={onSort}><SortGlyph /> Sort</button>
      <button type="button" className="tb labelled" aria-label="Insert chart" title="Chart of the selected cells" onMouseDown={keep} onClick={onChart}><Icon name="chart" size={18} /> Chart</button>
      <button type="button" className="tb labelled" aria-label="Add comment" title="Comment on this cell (Ctrl+Alt+M)" onMouseDown={keep} onClick={onComment}><Icon name="chat" size={18} /> Comment</button>
    </div>
  );
}

function AlignGlyph({ to }) {
  const lines = to === 'center' ? [[4, 16], [7, 10], [4, 16], [7, 10]] : to === 'right' ? [[4, 16], [10, 10], [4, 16], [10, 10]] : [[4, 16], [4, 10], [4, 16], [4, 10]];
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">{lines.map(([x, w], i) => <rect key={i} x={x} y={5 + i * 4} width={w} height="2" rx="1" fill="currentColor" />)}</svg>;
}

function SortGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z" /></svg>;
}

function RulesGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" opacity=".35" /><path fill="currentColor" d="M13 13h7v7h-7z" /></svg>;
}
