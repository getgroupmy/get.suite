import { pasteSpecial, PASTE_MODES } from './paste.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { get, patch } from '../../api.js';
import DrivePicker from '../../components/DrivePicker.jsx';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { jsonFromSheetDoc, applySheetJson } from '../collabsync.js';
import { useAuth } from '../../App.jsx';
import { useToast, PromptModal, ConfirmModal, Menu, Avatar, ContextMenu, Modal } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { EditorHeader } from '../editorCommon.jsx';
import { CommentsPanel, useComments } from '../comments.jsx';
import { ChartCard, ChartDialog } from './SheetCharts.jsx';
import { dataRegion, rangeText, parseRange } from './charts.js';
import { applyStructure, adjustKey, sortRange, looksLikeHeader, adjustOtherSheets, renameSheetRefs, renameSource } from './structure.js';
import { removeDuplicates, splitColumn } from './data.js';
import { DedupeDialog, SplitDialog } from './SheetData.jsx';
import { NamesDialog } from './SheetNames.jsx';
import { FunctionsDialog } from './SheetFunctions.jsx';
import { targetOf, cleanTarget } from './names.js';
import { SortDialog } from './SheetSort.jsx';
import { PivotDialog } from './SheetPivot.jsx';
import { buildPivotTable, pivotCells, sourceTable } from './pivot.js';
import { RulesDialog } from './SheetRules.jsx';
import { ValidationDialog, ChoicePicker } from './SheetValidation.jsx';
import { CellPicture, PictureCellDialog } from './SheetPicture.jsx';
import { CustomFormatDialog } from './SheetNumFmt.jsx';
import { heightOf, setHeights, MIN_H, MAX_H, DEFAULT_H } from './rowheights.js';
import { validationAt, checkEntry, isTicked, withChoices, choicesFrom, chipColour, breaksRule, describeCheck } from './validation.js';
import { hiddenRows, columnValues, adjustFilter, filterArea, columnFiltered, slicerAsFilter, adjustSlicers, sheetHiddenRows } from './filter.js';
import { SlicerCard } from './SheetSlicer.jsx';
import { describeCondition } from './filtercond.js';
import { setHidden, anyHidden, hiddenRuns } from './hide.js';
import { addGroup, removeGroups, toggleGroup, collapsedOn, toggleAt } from './groups.js';
import { FilterMenu } from './SheetFilter.jsx';
import { SheetPreview, SheetChanges } from './SheetPreview.jsx';
import { VersionHistory } from '../VersionHistory.jsx';
import { ruleStyle, ruleContext } from './condformat.js';
import { bandStyle } from './bands.js';
import { copyFormats, paintFormats } from './paint.js';
import { BandsDialog } from './SheetBands.jsx';
import { ColumnStatsDialog } from './SheetStats.jsx';
import { sheetPrintHtml, usedArea } from './sheetprint.js';
import { printHtml } from '../mail/mailprint.js';
import { useUndo, undoKey } from '../useUndo.js';
import { useFormulaAssist } from './FormulaAssist.jsx';
import { box, mergeLayout, mergeAt, addMerge, removeMerges, growToMerges, stepWithMerges } from './merge.js';
import { SheetFind } from './SheetFind.jsx';
import { brokenProtections, protectionsAt, mayEdit, rangeBox } from './protect.js';
import { ProtectDialog } from './SheetProtect.jsx';
import { MailMergeDialog } from './MailMerge.jsx';
import { useMailStatus } from '../../mailStatus.js';
import { fillCells, fillTarget, fillSources, selectionStats } from './fill.js';

const SEL_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#8430ce', '#00796b', '#c2185b', '#5f6368'];
const colorFor = (id) => SEL_COLORS[[...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % SEL_COLORS.length];
import { importBook, importWeb, onImports, refreshImports, refreshWeb } from './imports.js';
import { GoalSeekDialog } from './SheetGoalSeek.jsx';
import { CompareSheets } from './SheetCompare.jsx';
import { createEvaluator, bookEvaluator, display, colName, cellKey, parseRef, shiftFormula, colIndex } from './formula.js';
import { NUMBER_FORMATS, CURRENCIES, DATE_STYLES, BORDERS, borderFor, decimals, formatNumber, cellStyle, mergeFormat, VALIGNS, ROTATIONS, codeColour } from './cellformat.js';

const TEXT_COLORS = [['', 'Automatic'], ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#1a73e8', 'Blue'], ['#8430ce', 'Purple'], ['#5f6368', 'Grey']];
const FILLS = [['', 'None'], ['#fce8e6', 'Light red'], ['#fef7e0', 'Light yellow'], ['#e6f4ea', 'Light green'], ['#e8f0fe', 'Light blue'], ['#f3e8fd', 'Light purple'], ['#f1f3f4', 'Light grey']];

const MIN_ROWS = 100;
const DEFAULT_W = 100; // column width in pixels when none is set
const MIN_W = 30, MAX_W = 800;
const MIN_COLS = 26;

function sheetSize(cells, spilled = []) {
  let rows = 0, cols = 0;
  for (const k of [...Object.keys(cells), ...spilled]) {
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
  const assist = useFormulaAssist(draft, setDraft, !!editing, data?.functions);
  const [dialog, setDialog] = useState(null);
  const mail = useMailStatus();
  const [nameBox, setNameBox] = useState(null); // what's being typed in the name box
  const dataRef = useRef(null);
  const gridRef = useRef();
  const clip = useRef(null);
  const [status, setStatus] = useState('connecting');
  const [others, setOthers] = useState([]);
  const readOnly = (file?.role === 'viewer' || file?.role === 'commenter') || !!file?.locked_at;
  const canComment = !!file && file.role !== 'viewer'; // commenters too, and on locked files
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
    get(`/files/${id}?open`).then((f) => {
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
    }).catch((e) => { if (e.status === 404) { navigate(`/access/${id}`, { replace: true }); return; } toast(e.message, 'error'); navigate('/drive'); });
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
  const notes = sheet?.notes || {}; // cell notes: plain text shown when the cell is pointed at or selected
  const charts = sheet?.charts || {};
  const colWidths = sheet?.colWidths || {};
  const rules = sheet?.rules || [];
  const bands = sheet?.bands || [];
  const validations = sheet?.validations || [];
  const merges = useMemo(() => sheet?.merges || [], [sheet?.merges]);
  const layout = useMemo(() => mergeLayout(merges), [merges]);
  const [picker, setPicker] = useState(null); // { key }: the choices of a dropdown cell are open
  const frozen = { rows: sheet?.frozen?.rows || 0, cols: sheet?.frozen?.cols || 0 };
  const [resizing, setResizing] = useState(null); // { c, w } while a column edge is dragged
  const widthOf = (c) => (resizing?.c === c ? resizing.w : colWidths[colName(c)] ?? DEFAULT_W);
  const [resizingRow, setResizingRow] = useState(null); // { r, h } while a row's bottom edge is dragged
  const rowH = (r) => (resizingRow?.r === r ? resizingRow.h : heightOf(sheet?.rowHeights, r));
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
  const names = sheet?.names || null; // named ranges: { Tax: 'B1' }
  // Protections on this sheet that keep this person out: whole-sheet ones get a banner, ranges are hatched.
  const guards = useMemo(() => (sheet?.protected || []).filter((p) => !p.warn && file && !mayEdit(p, user.id, file.owner_id)), [sheet?.protected, file, user.id]);
  const sheetGuard = guards.find((p) => !p.range);
  const guardBoxes = useMemo(() => guards.filter((p) => p.range).map((p) => rangeBox(p.range)).filter(Boolean), [guards]);
  const guarded = (c, r) => guardBoxes.some((b) => c >= b.c1 && c <= b.c2 && r >= b.r1 && r <= b.r2);
  // Formulas can use the other sheets too (Sheet2!A1).
  // …and other spreadsheets (IMPORTRANGE), loaded in the background and checked again each minute and on coming back to the tab.
  const [importsAt, setImportsAt] = useState(0);
  useEffect(() => {
    const off = onImports(() => setImportsAt((n) => n + 1));
    const t = setInterval(refreshImports, 60000);
    const w = setInterval(refreshWeb, 5 * 60000); // IMPORTDATA / IMPORTHTML: pages on the internet, every 5 minutes
    window.addEventListener('focus', refreshImports); // back from the other spreadsheet: its latest
    return () => { off(); clearInterval(t); clearInterval(w); window.removeEventListener('focus', refreshImports); };
  }, []);
  const evaluate = useMemo(() => (data?.sheets ? bookEvaluator(data.sheets, Math.min(active, data.sheets.length - 1), { book: importBook, web: importWeb, depth: 0 }, data.functions) : createEvaluator(cells, names)), [data?.sheets, data?.functions, active, cells, names, importsAt]);
  const ruleCtx = useMemo(() => ruleContext(evaluate, evaluate.formulaAt), [evaluate]); // for whole-range and custom formula rules
  // A cell's value on this sheet (sheet null) or another tab by name, for dropdowns taking their choices from a range.
  const valueOf = useMemo(() => {
    const others = new Map();
    return (name, key) => {
      if (!name || !data?.sheets) return evaluate(key);
      const i = data.sheets.findIndex((s) => String(s.name).toLowerCase() === String(name).toLowerCase());
      if (i < 0) return null;
      if (i === Math.min(active, data.sheets.length - 1)) return evaluate(key);
      if (!others.has(i)) others.set(i, bookEvaluator(data.sheets, i, { book: importBook, web: importWeb, depth: 0 }, data.functions));
      return others.get(i)(key);
    };
  }, [evaluate, data?.sheets, data?.functions, active]);
  const { rows, cols } = useMemo(() => sheetSize(cells, evaluate.spilledKeys?.() || []), [cells, evaluate]);
  // The filter: which rows it hides, and where its headings are.
  const filter = sheet?.filter || null;
  const hide = sheet?.hide || null; // rows and columns hidden by hand
  const groups = sheet?.groups || null; // grouped rows and columns (collapsed ones are hidden too)
  const slicers = sheet?.slicers || {};
  const hidden = useMemo(() => sheetHiddenRows({ cells, filter, slicers, hide, groups }, evaluate), [filter, slicers, cells, evaluate, hide, groups]);
  const hiddenCols = useMemo(() => new Set([...(hide?.cols || []), ...collapsedOn(groups, 'col')]), [hide, groups]);
  const groupToggle = useMemo(() => ({ row: toggleAt(groups, 'row'), col: toggleAt(groups, 'col') }), [groups]);
  const inGroup = (axis, i) => (groups || []).some((g) => g.axis === axis && i >= g.from && i <= g.to);
  const flipGroup = (axis, from) => writeSheet((sh) => ({ groups: toggleGroup(sh.groups, axis, from) }));
  // Where to put the "show hidden" buttons: on the heading just after each run (or just before, at the end).
  const unhideAt = useMemo(() => {
    const at = { row: new Map(), col: new Map() };
    for (const [axis, list] of [['row', hide?.rows], ['col', hide?.cols]]) {
      for (const [a, b] of hiddenRuns(list)) { if (a > 0) at[axis].set(a - 1, { a, b, side: 'after' }); else at[axis].set(b + 1, { a, b, side: 'before' }); }
    }
    return at;
  }, [hide]);
  const fArea = useMemo(() => (filter ? filterArea(filter, cells) : null), [filter, cells]);
  const [filterMenu, setFilterMenu] = useState(null); // { c }
  // Find and replace: the bar ({ replace, n }), and the cells it highlights.
  const [finding, setFinding] = useState(null);
  const [hits, setHits] = useState(null); // { keys: Set, current }
  const shown = useCallback((k) => { const v = evaluate(k); return formatNumber(v, formats[k]) ?? display(v); }, [evaluate, formats]);
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (k !== 'f' && k !== 'h')) return;
      if (document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      setFinding((f) => ({ replace: k === 'h' || !!f?.replace, n: (f?.n || 0) + 1 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Protected ranges: confirmed warnings (by id) aren't asked about again while the sheet is open.
  const warned = useRef(new Set());
  function commitData(next) {
    if (readOnly || !ydoc) return;
    const broken = brokenProtections(dataRef.current, next, user.id, file.owner_id, { warnings: true }).filter(({ p }) => !warned.current.has(p.id));
    const hard = broken.find(({ p }) => !p.warn);
    if (hard) { toast(`${hard.p.range ? `${hard.sheet}!${hard.p.range}` : `The sheet “${hard.sheet}”`} is protected${hard.p.desc ? ` (${hard.p.desc})` : ''}. Only some people can change it.`, 'error'); return; }
    if (broken.length) { setDialog({ type: 'protect-warn', next, list: broken }); return; }
    dataRef.current = next;
    setData(next);
    applySheetJson(ydoc, next); // only the cells that changed go to the others
  }

  function writeCells(updates) {
    if (readOnly) return;
    if (dataRef.current.sheets[active]?.pivot) { toast('This sheet is a pivot table: change it with Edit pivot table above', 'error'); return; }
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
  /** change: the same for every selected cell, or fn(key, c, r, format) → change (borders depend on the place). */
  function writeFormats(change) {
    if (readOnly) return;
    const cur = dataRef.current;
    const sheets = cur.sheets.map((s, i) => {
      if (i !== active) return s;
      const f = { ...(s.formats || {}) };
      for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
        const k = cellKey(c, r);
        const m = mergeFormat(f[k], typeof change === 'function' ? change(k, c, r, f[k]) : change);
        if (m) f[k] = m; else delete f[k];
      }
      return { ...s, formats: f };
    });
    commitData({ ...cur, sheets });
  }

  // Paint format: { pattern, sticky } while the brush is on; the next selection made with the mouse
  // takes the copied formatting (once, or until Esc after a double-click).
  const [painter, setPainter] = useState(null);
  const rangeRef = useRef(null);
  const startPaint = (sticky) => setPainter({ pattern: copyFormats(sheet?.formats, range), sticky });
  useEffect(() => {
    if (!painter) return undefined;
    const up = () => setTimeout(() => {
      const target = rangeRef.current;
      if (!target || readOnly) return;
      const cur = dataRef.current;
      commitData({ ...cur, sheets: cur.sheets.map((sh, i) => (i === active ? { ...sh, formats: paintFormats(sh.formats, target, painter.pattern) } : sh)) });
      if (!painter.sticky) setPainter(null);
    }, 0);
    const esc = (e) => { if (e.key === 'Escape') setPainter(null); };
    const grid = gridRef.current;
    grid?.addEventListener('mouseup', up);
    window.addEventListener('keydown', esc);
    return () => { grid?.removeEventListener('mouseup', up); window.removeEventListener('keydown', esc); };
  }, [painter, active, readOnly]);

  /** Merge the selected cells (keeping the top-left value), or unmerge what the selection touches. */
  function toggleMerge() {
    if (readOnly) return;
    const cur = dataRef.current;
    const inMerge = mergeAt(merges, sel.c, sel.r);
    const one = range.c1 === range.c2 && range.r1 === range.r2;
    if (one && !inMerge) { toast('Select two or more cells to merge'); return; }
    let dropped = 0;
    const sheets = cur.sheets.map((sh, i) => {
      if (i !== active) return sh;
      if (inMerge && (one || (range.c1 === inMerge.c1 && range.r1 === inMerge.r1 && range.c2 === inMerge.c2 && range.r2 === inMerge.r2))) {
        const left = removeMerges(sh.merges || [], range);
        return { ...sh, merges: left };
      }
      const nextCells = { ...sh.cells };
      for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
        const k = cellKey(c, r);
        if ((c !== range.c1 || r !== range.r1) && nextCells[k] !== undefined && nextCells[k] !== '') { delete nextCells[k]; dropped++; }
      }
      return { ...sh, cells: nextCells, merges: addMerge(sh.merges || [], range) };
    });
    commitData({ ...cur, sheets });
    setAnchor(null);
    setSel({ c: range.c1, r: range.r1 });
    if (dropped) toast(`Merged: only the top-left value is kept (${dropped} other ${dropped === 1 ? 'value' : 'values'} cleared; Undo brings them back)`);
  }

  /** Change this sheet's own settings (column widths, frozen panes): fn(sheet) → changes. */
  // Cell notes: { key, text, x, y } while one is being written.
  const [noteEdit, setNoteEdit] = useState(null);
  const editNote = (key = cellKey(sel.c, sel.r)) => {
    if (readOnly) return;
    const r = gridRef.current?.querySelector(`[data-k="${key}"]`)?.getBoundingClientRect();
    setNoteEdit({ key, text: (dataRef.current.sheets[active]?.notes || {})[key] || '', x: r ? r.right + 4 : 200, y: r ? r.top : 200 });
  };
  const saveNote = (key, text) => {
    const t = String(text || '').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
    writeSheet((sh) => { const n = { ...(sh.notes || {}) }; if (t) n[key] = t; else delete n[key]; return { notes: n }; });
  };
  function writeSheet(fn) {
    if (readOnly) return;
    const cur = dataRef.current;
    commitData({ ...cur, sheets: cur.sheets.map((s, i) => (i === active ? { ...s, ...fn(s) } : s)) });
  }
  const setWidth = (c, w) => writeSheet((s) => ({ colWidths: { ...(s.colWidths || {}), [colName(c)]: Math.round(Math.max(MIN_W, Math.min(MAX_W, w))) } }));
  /** Hide rows or columns a..b (or show them again). The selection steps off any it hides. */
  const hideSpan = (axis, a, b, show = false) => {
    writeSheet((s) => ({ hide: setHidden(s.hide, axis, a, b, show) }));
    if (!show) {
      const limit = axis === 'row' ? rows : cols;
      const to = b + 1 < limit ? b + 1 : Math.max(0, a - 1);
      setAnchor(null);
      setSel((p) => (axis === 'row' ? { ...p, r: to } : { ...p, c: to }));
    }
    gridRef.current?.focus();
  };
  const setFrozen = (rowsN, colsN) => writeSheet((s) => {
    const f = { rows: rowsN ?? (s.frozen?.rows || 0), cols: colsN ?? (s.frozen?.cols || 0) };
    return { frozen: f.rows || f.cols ? f : null };
  });
  /** Rows a..b (0-based) to h pixels tall, or back to the standard height (h empty). */
  const setRowHeight = (a, b, h) => writeSheet((sh) => ({ rowHeights: setHeights(sh.rowHeights, a, b, h) }));
  /** Drag a row number's bottom edge to make the row taller or shorter; double-click for the standard height. */
  const startRowResize = (r) => (e) => {
    if (readOnly || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const y0 = e.clientY, h0 = rowH(r) || e.currentTarget.parentElement.getBoundingClientRect().height;
    const move = (ev) => setResizingRow({ r, h: Math.max(MIN_H, Math.min(MAX_H, h0 + ev.clientY - y0)) });
    const up = (ev) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setResizingRow(null);
      if (Math.abs(ev.clientY - y0) > 1) setRowHeight(r, r, h0 + ev.clientY - y0);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
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
    // References to this sheet from the others move too.
    commitData({ ...cur, sheets: adjustOtherSheets(cur.sheets, active, change).map((s, i) => (i === active ? { ...applyStructure(s, change), ...(s.filter && { filter: adjustFilter(s.filter, change) }), ...(s.slicers && { slicers: adjustSlicers(s.slicers, change) }) } : s)) });
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
    if (merges.some((m) => { const b = box(m); return b && b.c1 <= g.c2 && g.c1 <= b.c2 && b.r1 <= g.r2 && g.r1 <= b.r2; })) { toast('Unmerge the cells in these rows before sorting them', 'error'); return; }
    const cur = dataRef.current;
    const sheets = cur.sheets.map((s, i) => (i === active ? { ...s, ...sortRange(s, g, by, { desc, header, value: evaluate }) } : s));
    commitData({ ...cur, sheets });
    toast(`Sorted rows ${g.r1 + (header ? 2 : 1)}–${g.r2 + 1} by column ${colName(by)}`);
    gridRef.current?.focus();
  }
  /** The cells a sort applies to: the selection, or with one cell selected, the table around it. */
  const sortTarget = () => (anchor ? range : dataRegion(sel, (c, r) => cells[cellKey(c, r)] !== undefined && cells[cellKey(c, r)] !== ''));
  /** Data tools: they touch the rows of a range (refused across merged cells, like sorting). */
  const touchesMerge = (g) => merges.some((m) => { const b = box(m); return b && b.c1 <= g.c2 && g.c1 <= b.c2 && b.r1 <= g.r2 && g.r1 <= b.r2; });
  function dedupe(g, { header }) {
    if (readOnly) return;
    if (touchesMerge(g)) { toast('Unmerge the cells in these rows first', 'error'); return; }
    const cur = dataRef.current;
    const out = removeDuplicates(cur.sheets[active], g, { header, value: evaluate });
    if (out.removed) commitData({ ...cur, sheets: cur.sheets.map((s, i) => (i === active ? { ...s, cells: out.cells, formats: out.formats } : s)) });
    toast(out.removed ? `Removed ${out.removed} duplicate row${out.removed === 1 ? '' : 's'}; ${out.kept} left` : 'No duplicate rows');
    gridRef.current?.focus();
  }
  function split(g, { sep }) {
    if (readOnly) return;
    const cur = dataRef.current;
    const out = splitColumn(cur.sheets[active], g, sep);
    if (out.columns < 2) { toast('Nothing to split there'); return; }
    commitData({ ...cur, sheets: cur.sheets.map((s, i) => (i === active ? { ...s, cells: out.cells } : s)) });
    toast(`Split into ${out.columns} columns${out.overwritten ? ` (${out.overwritten} cell${out.overwritten === 1 ? '' : 's'} written over)` : ''}`);
    gridRef.current?.focus();
  }
  // ---- pivot tables: a sheet with { pivot } is filled from its source whenever the data changes ----
  const pivotHeadings = (src, p) => {
    const ev = createEvaluator(src.cells || {}, src.names);
    const out = [];
    for (let c = p.c1; c <= p.c2; c++) { const v = ev(cellKey(c, p.r1)); out.push({ c, label: v && typeof v !== 'object' ? String(v) : '' }); }
    return out;
  };
  /** The sheets with their pivot tables brought up to date (and whether anything changed). */
  function refreshPivots(cur) {
    let changed = false;
    const sheets = cur.sheets.map((s) => {
      if (!s.pivot) return s;
      const src = cur.sheets.find((x) => x.name === s.pivot.source);
      if (!src || src === s) return s;
      const ev = createEvaluator(src.cells || {}, src.names);
      let last = s.pivot.r1;
      for (const k of Object.keys(src.cells || {})) { const p = parseRef(k); if (p && p.c >= s.pivot.c1 && p.c <= s.pivot.c2) last = Math.max(last, p.r); }
      const shown = (k) => { const v = ev(k); return v && typeof v === 'object' ? '' : v ?? ''; };
      const rel = (c) => (c === null || c === undefined ? null : c - s.pivot.c1);
      const p = s.pivot;
      const { grid, percent } = buildPivotTable(sourceTable(p, shown, last), {
        rows: rel(p.rows), cols: rel(p.cols), value: rel(p.value), fn: p.fn,
        ...(p.values?.length && { values: p.values.map((v) => ({ col: rel(v.col), fn: v.fn })) }),
        group: p.group || null, show: p.show || 'value', sort: p.sort || 'label',
        ...(p.filter?.hide?.length && { filter: { col: rel(p.filter.col), hide: p.filter.hide } }),
      });
      const { cells: pc, formats: pf } = pivotCells(grid, { percent });
      if (JSON.stringify(pc) === JSON.stringify(s.cells || {}) && JSON.stringify(pf) === JSON.stringify(s.formats || {})) return s;
      changed = true;
      return { ...s, cells: pc, formats: pf };
    });
    return changed ? { ...cur, sheets } : null;
  }
  useEffect(() => {
    if (readOnly || !data?.sheets.some((s) => s.pivot)) return undefined;
    const t = setTimeout(() => { const next = refreshPivots(dataRef.current); if (next) commitData(next); }, 250);
    return () => clearTimeout(t);
  }, [data, readOnly]);
  function savePivot(spec, { index = null } = {}) {
    const cur = dataRef.current;
    let next;
    if (index === null) {
      let n = 1;
      while (cur.sheets.some((s) => s.name === `Pivot table ${n}`)) n++;
      next = { ...cur, sheets: [...cur.sheets, { name: `Pivot table ${n}`, cells: {}, colWidths: { A: 160 }, frozen: { rows: 1 }, pivot: spec }] };
    } else next = { ...cur, sheets: cur.sheets.map((s, i) => (i === index ? { ...s, pivot: spec } : s)) };
    commitData(refreshPivots(next) || next);
    if (index === null) { setActive(next.sheets.length - 1); setSel({ c: 0, r: 0 }); setAnchor(null); }
    setDialog(null);
  }
  function newPivot() {
    const g = sortTarget();
    if (g.r2 <= g.r1) { toast('Select a table with headings and at least one row of data first', 'error'); return; }
    if (sheet.pivot) { toast('Pick the data on another sheet first', 'error'); return; }
    const spec = { source: sheet.name, c1: g.c1, c2: g.c2, r1: g.r1, rows: g.c1, cols: null, value: g.c2 > g.c1 ? g.c2 : null, fn: 'sum' };
    setDialog({ type: 'pivot', spec, headings: pivotHeadings(sheet, spec), index: null });
  }
  /** The pivot's data as it shows (for the filter's list of values). */
  function pivotSource(spec) {
    const src = dataRef.current.sheets.find((x) => x.name === spec.source);
    if (!src) return [];
    const ev = createEvaluator(src.cells || {}, src.names);
    let last = spec.r1;
    for (const k of Object.keys(src.cells || {})) { const p = parseRef(k); if (p && p.c >= spec.c1 && p.c <= spec.c2) last = Math.max(last, p.r); }
    return sourceTable(spec, (k) => { const v = ev(k); return v && typeof v === 'object' ? '' : v ?? ''; }, last);
  }
  function editPivot() {
    const src = data.sheets.find((x) => x.name === sheet.pivot.source);
    if (!src) { toast(`The data sheet “${sheet.pivot.source}” is gone`, 'error'); return; }
    setDialog({ type: 'pivot', spec: sheet.pivot, headings: pivotHeadings(src, sheet.pivot), index: active });
  }

  const quickSort = (desc) => { const g = sortTarget(); sortBy({ range: g, by: sel.c, desc, header: looksLikeHeader(g, evaluate) }); };

  // The selection (grown to take in any merged cells it touches, so it never cuts one in two).
  const range = growToMerges(merges, anchor ? {
    c1: Math.min(anchor.c, sel.c), c2: Math.max(anchor.c, sel.c), r1: Math.min(anchor.r, sel.r), r2: Math.max(anchor.r, sel.r),
  } : { c1: sel.c, c2: sel.c, r1: sel.r, r2: sel.r });
  rangeRef.current = range;
  const inRange = (c, r) => c >= range.c1 && c <= range.c2 && r >= range.r1 && r <= range.r2;

  // Filling: the fill handle (the square at the selection's corner) dragged over cells, or Ctrl+D / Ctrl+R.
  const [filling, setFilling] = useState(null); // the box being dragged out to
  const inFill = (c, r) => filling && c >= filling.c1 && c <= filling.c2 && r >= filling.r1 && r <= filling.r2 && !inRange(c, r);
  function fillTo(target, from = range) {
    if (readOnly || !target) return;
    const u = fillCells(cells, from, target);
    if (!Object.keys(u).length) return;
    if (dataRef.current.sheets[active]?.pivot) { toast('This sheet is a pivot table: change it with Edit pivot table above', 'error'); return; }
    // Values and formats in one change (so a protected range refuses the whole fill).
    const src = fillSources(from, target);
    const cur = dataRef.current;
    commitData({ ...cur, sheets: cur.sheets.map((s, i) => {
      if (i !== active) return s;
      const nextCells = { ...s.cells }, nextFormats = { ...(s.formats || {}) };
      for (const [k, v] of Object.entries(u)) { if (v === '' || v == null) delete nextCells[k]; else nextCells[k] = v; }
      for (const [k, from0] of Object.entries(src)) { if (s.formats?.[from0]) nextFormats[k] = s.formats[from0]; else delete nextFormats[k]; }
      return { ...s, cells: nextCells, formats: nextFormats };
    }) });
    setAnchor({ c: target.c1, r: target.r1 }); setSel({ c: target.c2, r: target.r2 });
  }
  function startFill(e) {
    e.preventDefault(); e.stopPropagation();
    const from = range;
    let target = null;
    const over = (ev) => {
      const td = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('td[data-k]');
      const p = td && parseRef(td.dataset.k);
      if (!p) return;
      target = fillTarget(from, p.c, p.r);
      setFilling(target);
    };
    const up = () => {
      window.removeEventListener('mousemove', over); window.removeEventListener('mouseup', up);
      setFilling(null);
      fillTo(target, from);
      gridRef.current?.focus();
    };
    window.addEventListener('mousemove', over); window.addEventListener('mouseup', up);
  }
  // Where the handle goes: the bottom-right corner of the selection, measured from the grid.
  const [handleAt, setHandleAt] = useState(null);
  useLayoutEffect(() => {
    const wrap = gridRef.current;
    const td = !readOnly && !editing && wrap?.querySelector(`td[data-k="${cellKey(range.c2, range.r2)}"]`);
    if (!td) { if (handleAt) setHandleAt(null); return; }
    const w = wrap.getBoundingClientRect(), b = td.getBoundingClientRect();
    const at = { left: b.right - w.left + wrap.scrollLeft - 4, top: b.bottom - w.top + wrap.scrollTop - 4 };
    if (!handleAt || at.left !== handleAt.left || at.top !== handleAt.top) setHandleAt(at);
  });
  // Sum, average and count of what's selected (when it's more than one cell).
  const stats = useMemo(() => {
    if (range.c1 === range.c2 && range.r1 === range.r2) return null;
    const vals = [];
    for (let r = range.r1; r <= Math.min(range.r2, range.r1 + 5000); r++) for (let c = range.c1; c <= range.c2; c++) {
      const k = cellKey(c, r);
      if (cells[k] === undefined || hidden.has(r)) continue;
      vals.push(evaluate(k));
    }
    return selectionStats(vals);
  }, [range.c1, range.c2, range.r1, range.r2, cells, evaluate, hidden]);

  function move(dc, dr, extend = false) {
    if (extend) { if (!anchor) setAnchor(sel); } else setAnchor(null);
    setSel((s) => {
      const n = extend ? { c: Math.max(0, Math.min(cols - 1, s.c + dc)), r: Math.max(0, Math.min(rows - 1, s.r + dr)) }
        : stepWithMerges(merges, s.c, s.r, dc, dr, { cols, rows }); // over merged cells as one
      // Rows the filter hides are skipped over.
      while (dr && hidden.has(n.r) && n.r > 0 && n.r < rows - 1) n.r += Math.sign(dr);
      if (hidden.has(n.r)) n.r = s.r;
      while (dc && hiddenCols.has(n.c) && n.c > 0 && n.c < cols - 1) n.c += Math.sign(dc); // and hidden columns
      if (hiddenCols.has(n.c)) n.c = s.c;
      requestAnimationFrame(() => gridRef.current?.querySelector(`[data-k="${cellKey(n.c, n.r)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      return n;
    });
  }

  function startEdit(initial, where = 'cell') {
    if (readOnly) return;
    const lock = protectionsAt(sheet, cellKey(sel.c, sel.r)).find((p) => !p.warn && !mayEdit(p, user.id, file.owner_id));
    if (lock) { toast(`This cell is protected${lock.desc ? ` (${lock.desc})` : ''}. Only some people can change it.`, 'error'); return; }
    closing.current = false;
    setEditing(where);
    setDraft(initial ?? cells[cellKey(sel.c, sel.r)] ?? '');
  }

  const closing = useRef(false); // set while the cell editor closes, so its blur doesn't save a second time
  /** Save what was typed. A value a strict dropdown doesn't allow: kept for fixing (keep) or dropped. */
  function commitEdit(dc = 0, dr = 0, keep = false) {
    if (closing.current) return; // the editor is already closing (its blur comes after Enter or Escape)
    const key = cellKey(sel.c, sel.r);
    const check = checkEntry(withChoices(validationAt(validations, key), valueOf), draft);
    if (check.error) { toast(check.error, 'error'); if (!keep) cancelEdit(); return; }
    if (check.warning) toast(`${check.warning}. It's kept, marked in red.`);
    writeCells({ [key]: check.value });
    closing.current = true;
    setEditing(null);
    move(dc, dr);
    gridRef.current?.focus();
  }

  function cancelEdit() { closing.current = true; setEditing(null); gridRef.current?.focus(); }
  /** Turn the filter on (over the selection, or the table around the cursor) or off. */
  const toggleFilter = () => {
    if (filter) { writeSheet(() => ({ filter: null })); toast('Filter removed: every row shows'); gridRef.current?.focus(); return; }
    const g = anchor ? range : dataRegion(sel, (c, r) => cells[cellKey(c, r)] !== undefined && cells[cellKey(c, r)] !== '');
    if (g.r2 <= g.r1) { toast('Select a table with headings in its first row', 'error'); return; }
    writeSheet(() => ({ filter: { range: rangeText(g), hidden: {} } }));
    gridRef.current?.focus();
  };
  /** A slicer for the table around the cursor, filtering by the cursor's column, placed above the table's right. */
  const newSlicer = () => {
    const g = anchor ? range : dataRegion(sel, (c, r) => cells[cellKey(c, r)] !== undefined && cells[cellKey(c, r)] !== '');
    if (g.r2 <= g.r1) { toast('Put the cursor in a table with headings in its first row', 'error'); return; }
    const col = colName(Math.min(Math.max(sel.c, g.c1), g.c2));
    const wrap = gridRef.current;
    const td = wrap?.querySelector(`[data-k="${cellKey(Math.min(g.c2 + 1, cols - 1), g.r1)}"]`);
    let x = 160, y = 40;
    if (td && wrap) { const a = td.getBoundingClientRect(), b = wrap.getBoundingClientRect(); x = a.left - b.left + wrap.scrollLeft + 12; y = a.top - b.top + wrap.scrollTop; }
    const id = (crypto.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^\w]/g, '').slice(0, 20);
    writeSheet((s) => ({ slicers: { ...(s.slicers || {}), [id]: { range: rangeText(g), col, hidden: [], x: Math.round(x), y: Math.round(y) } } }));
    toast(`Slicer added for ${display(evaluate(`${col}${g.r1 + 1}`)) || `column ${col}`}: click it to choose what to show`);
    gridRef.current?.focus();
  };
  const writeSlicer = (id, next) => writeSheet((s) => { const all = { ...(s.slicers || {}) }; if (next) all[id] = next; else delete all[id]; return { slicers: all }; });
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
    else if (k === 'F2' && e.shiftKey) { e.preventDefault(); editNote(); } // Shift+F2: the cell's note, as in Excel and Google Sheets
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
    } else if (e.altKey && e.shiftKey && e.code === 'Digit5') { e.preventDefault(); writeFormats({ s: !formats[cellKey(sel.c, sel.r)]?.s }); }
    else if (mod && !e.shiftKey && !e.altKey && (k.toLowerCase() === 'd' || k.toLowerCase() === 'r')) {
      // Fill down / right: the selection's first row (column) into the rest; a single cell copies the one above (left).
      e.preventDefault();
      const down = k.toLowerCase() === 'd';
      if (down) { if (range.r2 > range.r1) fillTo(range, { ...range, r2: range.r1 }); else if (range.r1 > 0) fillTo(range, { ...range, r1: range.r1 - 1, r2: range.r1 - 1 }); }
      else if (range.c2 > range.c1) fillTo(range, { ...range, c2: range.c1 }); else if (range.c1 > 0) fillTo(range, { ...range, c1: range.c1 - 1, c2: range.c1 - 1 });
    }
    else if (mod && e.shiftKey && k.toLowerCase() === 'v') { pasteMode.current = 'values'; setTimeout(() => { pasteMode.current = null; }, 1000); } // the browser's paste follows
    else if (mod && k.toLowerCase() === 'a') { e.preventDefault(); setAnchor({ c: 0, r: 0 }); setSel({ c: cols - 1, r: rows - 1 }); }
    else if (mod && e.altKey && e.code === 'KeyM') { e.preventDefault(); startComment(); }
    else if (!mod && !e.altKey && k.length === 1) { e.preventDefault(); startEdit(k); }
  }

  function onCopy(e) {
    if (editing) return;
    e.preventDefault();
    const raws = [];
    const fmts = [];
    const shownVals = []; // what the cells show, unformatted, for Paste special → Values only
    const lines = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const rawRow = [], vals = [], fmtRow = [], plain = [];
      for (let c = range.c1; c <= range.c2; c++) {
        const k = cellKey(c, r);
        rawRow.push(cells[k] ?? '');
        fmtRow.push(formats[k] || null);
        vals.push(formatNumber(evaluate(k), formats[k]) ?? display(evaluate(k)));
        plain.push(display(evaluate(k)));
      }
      raws.push(rawRow);
      fmts.push(fmtRow);
      shownVals.push(plain);
      lines.push(vals.join('\t'));
    }
    const text = lines.join('\n');
    clip.current = { text, raws, fmts, vals: shownVals, origin: { c: range.c1, r: range.r1 } };
    e.clipboardData.setData('text/plain', text);
  }

  function onCut(e) {
    if (editing || readOnly) return;
    onCopy(e);
    const u = {};
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) u[cellKey(c, r)] = '';
    writeCells(u);
  }

  /** Paste special (values, formatting, transposed) from what was copied in this spreadsheet. */
  function pasteAs(mode) {
    if (readOnly) return;
    if (!clip.current) { toast('Copy some cells in this spreadsheet first, then paste them this way', 'error'); return; }
    const p = pasteSpecial(clip.current, { c: sel.c, r: sel.r }, mode, shiftFormula);
    const cur = dataRef.current;
    const sheets = cur.sheets.map((s, i) => {
      if (i !== active) return s;
      const nextCells = { ...s.cells };
      for (const [k, v] of Object.entries(p.cells)) { if (v === '' || v == null) delete nextCells[k]; else nextCells[k] = v; }
      const f = { ...(s.formats || {}) };
      for (const [k, fm] of Object.entries(p.formats)) { if (fm) f[k] = fm; else delete f[k]; }
      return { ...s, cells: nextCells, formats: f };
    });
    commitData({ ...cur, sheets });
    setAnchor({ c: sel.c + p.size.cols - 1, r: sel.r + p.size.rows - 1 });
    gridRef.current?.focus();
  }
  const pasteMode = useRef(null); // Ctrl+Shift+V: the paste that follows is values only

  function onPaste(e) {
    if (editing || readOnly) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r/g, '').replace(/\n$/, '');
    const asValues = pasteMode.current === 'values';
    pasteMode.current = null;
    if (asValues && clip.current && clip.current.text === text) { pasteAs('values'); return; }
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
    for (const k of [...Object.keys(cells), ...(evaluate.spilledKeys?.() || [])]) { const p = parseRef(k); if (p) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
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
  const selText = anchor && (range.c1 !== range.c2 || range.r1 !== range.r2) ? `${cellKey(range.c1, range.r1)}:${cellKey(range.c2, range.r2)}` : selKey;
  // The name box: the selection's name if it has one; type a cell, a range or a name to go there.
  const selName = Object.entries(names || {}).find(([, t]) => t === selText)?.[0];
  const goTo = (text) => {
    const t = cleanTarget(targetOf(names, text) || text);
    if (!t) { toast(`There's no cell or named range called “${text}”`, 'error'); return false; }
    const [a, b = a] = t.split(':').map(parseRef);
    if (a.c === b.c && a.r === b.r) setAnchor(null); else setAnchor({ c: b.c, r: b.r });
    setSel({ c: a.c, r: a.r });
    requestAnimationFrame(() => { gridRef.current?.querySelector(`[data-k="${cellKey(a.c, a.r)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); gridRef.current?.focus(); });
    return true;
  };
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
    if (!canComment) return;
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
    { label: nr > 1 ? `Resize rows ${range.r1 + 1}–${range.r2 + 1}…` : `Resize row ${range.r1 + 1}…`, onClick: () => setDialog({ type: 'rowheight', a: range.r1, b: range.r2 }) },
    ...(Array.from({ length: nr }, (_, i) => heightOf(sheet?.rowHeights, range.r1 + i)).some(Boolean) ? [{ label: 'Standard row height', onClick: () => setRowHeight(range.r1, range.r2, null) }] : []),
  ];
  const colItems = [
    { label: `Insert ${nc > 1 ? `${nc} columns` : '1 column'} left`, icon: 'plus', onClick: () => changeStructure({ axis: 'col', at: range.c1, count: nc }) },
    { label: `Insert ${nc > 1 ? `${nc} columns` : '1 column'} right`, icon: 'plus', onClick: () => changeStructure({ axis: 'col', at: range.c2 + 1, count: nc }) },
    { label: nc > 1 ? `Delete columns ${colName(range.c1)}–${colName(range.c2)}` : `Delete column ${colName(range.c1)}`, icon: 'trash', danger: true, onClick: () => changeStructure({ axis: 'col', at: range.c1, count: -nc }) },
    { label: 'Column stats…', onClick: () => setDialog({ type: 'colstats', c: range.c1 }) },
  ];
  const sortItems = [
    { label: `Sort A → Z by column ${colName(sel.c)}`, onClick: () => quickSort(false) },
    { label: `Sort Z → A by column ${colName(sel.c)}`, onClick: () => quickSort(true) },
    { label: 'Sort range…', onClick: () => setDialog({ type: 'sort' }) },
    '-',
    { label: 'Alternating colours…', onClick: () => setDialog({ type: 'bands' }) },
    { label: 'Remove duplicates…', onClick: () => setDialog({ type: 'dedupe' }) },
    { label: 'Split text to columns…', onClick: () => setDialog({ type: 'split' }) },
    { label: 'Pivot table…', onClick: newPivot },
    { label: 'Name this range…', onClick: () => setDialog({ type: 'names', initial: selText }) },
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
  const rowSpan = nr > 1 ? `rows ${range.r1 + 1}–${range.r2 + 1}` : `row ${range.r1 + 1}`;
  const colSpan = nc > 1 ? `columns ${colName(range.c1)}–${colName(range.c2)}` : `column ${colName(range.c1)}`;
  const hideItems = (axis) => {
    const [a, b, what] = axis === 'row' ? [range.r1, range.r2, rowSpan] : [range.c1, range.c2, colSpan];
    return [
      { label: `Hide ${what}`, onClick: () => hideSpan(axis, a, b) },
      anyHidden(hide, axis, a, b) && { label: `Unhide ${axis === 'row' ? 'rows' : 'columns'}`, onClick: () => hideSpan(axis, a, b, true) },
      { label: `Group ${what}`, onClick: () => { const next = addGroup(groups, axis, a, b); if (!next) return toast('Those overlap a group already there: ungroup it first', 'error'); writeSheet(() => ({ groups: next })); } },
      (groups || []).some((g) => g.axis === axis && g.from <= b && a <= g.to) && { label: `Ungroup ${axis === 'row' ? 'rows' : 'columns'}`, onClick: () => writeSheet((sh) => ({ groups: removeGroups(sh.groups, axis, a, b) })) },
    ];
  };
  rowItems.push(...hideItems('row'), '-', ...freezeRows);
  colItems.push(...hideItems('col'), '-', ...freezeCols);
  const noteItems = notes[selKey]
    ? [{ label: 'Edit note', icon: 'edit', onClick: () => editNote(selKey) }, { label: 'Delete note', icon: 'trash', onClick: () => saveNote(selKey, '') }]
    : [{ label: 'Insert note', icon: 'edit', onClick: () => editNote(selKey) }];
  noteItems.push({ label: 'Insert picture in cell…', icon: 'image', onClick: () => setDialog({ type: 'picture', key: selKey }) });
  const pasteItems = PASTE_MODES.map(([mode, label]) => ({ label: `Paste special: ${label.toLowerCase()}`, onClick: () => pasteAs(mode), disabled: !clip.current }));
  const ctxItems = ctx?.kind === 'row' ? rowItems : ctx?.kind === 'col' ? [...colItems, '-', ...sortItems] : [...rowItems, '-', ...colItems, '-', ...pasteItems, '-', ...noteItems, '-', ...sortItems];
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
          {readOnly && canComment && <button type="button" className="btn small" onClick={startComment}>Comment on {anchor ? 'this cell' : selKey}</button>}
          <button type="button" className={`btn small ${panel ? 'primary' : ''}`} aria-pressed={panel} onClick={() => { if (panel && pending) setPending(null); setPanel(!panel); }} title="Comments">
            <Icon name="chat" size={16} /> {openThreads.length || ''}<span className="sr-only">Comments</span>
          </button>
          {people.length > 0 && (
          <div className="coeditors" aria-label={`Also here: ${people.map((p) => p.name).join(', ')}`}>
            {people.slice(0, 4).map((p) => <span key={p.id} className="coeditor" style={{ '--c': p.color }} title={`${p.name} is here`}><Avatar name={p.name} size={28} userId={p.id} /></span>)}
            {people.length > 4 && <span className="muted small">+{people.length - 4}</span>}
          </div>
          )}
        </>}
        menu={[
          { label: 'Find and replace', icon: 'search', onClick: () => setFinding({ replace: !readOnly, n: 1 }) },
          { label: 'Named ranges', icon: 'link', onClick: () => setDialog({ type: 'names', initial: selText }) },
          { label: 'Named functions', icon: 'edit', onClick: () => setDialog({ type: 'functions' }) },
          !readOnly && { label: 'Goal seek…', icon: 'search', onClick: () => setDialog({ type: 'goalseek' }) },
          { label: 'Protected sheets and ranges', icon: 'lock', onClick: () => setDialog({ type: 'protect', initial: selText }) },
          mail?.enabled && { label: 'Mail merge…', icon: 'mail', onClick: () => setDialog({ type: 'mailmerge' }) },
          { label: 'Version history', icon: 'clock', onClick: () => setDialog({ type: 'history' }) },
          { label: 'Compare spreadsheets', icon: 'sheet', onClick: () => setDialog({ type: 'compare-pick' }) },
          { label: 'Print or save as PDF', icon: 'print', onClick: () => setDialog({ type: 'print' }) },
          { label: 'Download as Excel (.xlsx)', icon: 'download', onClick: () => { window.location.href = `/api/files/${id}/export`; } },
          { label: 'Download as OpenDocument (.ods)', icon: 'download', onClick: () => { window.location.href = `/api/files/${id}/export?format=ods`; } },
          { label: 'Download sheet as CSV', icon: 'download', onClick: exportCsv },
          !readOnly && { label: 'Import CSV as new sheet', icon: 'upload', onClick: importCsv },
        ]}
      />
      {status === 'offline' && <div className="banner warn">You're offline. Keep editing: your changes are kept here and sync when the connection is back.</div>}
      {readOnly && <div className="banner">{file.locked_at ? 'Locked.' : file.role === 'commenter' ? 'You can comment, not edit.' : 'View only.'} {!file.locked_at && `Ask ${file.owner_name} for edit access.`}</div>}
      {!readOnly && sheetGuard && <div className="banner" role="status">🔒 This sheet is protected{sheetGuard.desc ? ` (${sheetGuard.desc})` : ''}: only some people can change it.</div>}
      {sheet?.pivot && (
        <div className="banner pivot-banner" role="status">
          Pivot table of <strong>{sheet.pivot.source}</strong> (columns {colName(sheet.pivot.c1)}–{colName(sheet.pivot.c2)}, from row {sheet.pivot.r1 + 1} down). It updates by itself when the data changes.
          {!readOnly && <button type="button" className="btn small" onClick={editPivot}>Edit pivot table</button>}
        </div>
      )}
      {!readOnly && <FormatBar sample={evaluate(selKey)} painter={painter} onPaint={(sticky) => (painter && !sticky ? setPainter(null) : startPaint(sticky))} fmt={formats[selKey] || {}} onChange={(change) => { writeFormats(change); gridRef.current?.focus(); }}
        onMerge={() => { toggleMerge(); gridRef.current?.focus(); }} merged={!!mergeAt(merges, sel.c, sel.r)}
        onBorders={(kind) => { writeFormats((k, c, r, f) => ({ bd: borderFor(kind, range, c, r, f?.bd) })); gridRef.current?.focus(); }} onComment={startComment} onChart={newChart} onSort={() => setDialog({ type: 'sort' })} onRules={() => setDialog({ type: 'rules' })} onValidation={() => setDialog({ type: 'validation' })} onPivot={newPivot} filterOn={!!filter} onFilter={toggleFilter} onSlicer={newSlicer} history={history} />}
      {finding && sheet && (
        <SheetFind key={`${active}-${finding.n}`} cells={cells} shown={shown} hidden={hidden} replacing={finding.replace} canEdit={!readOnly}
          onGo={(m) => { setAnchor(null); setSel({ c: m.c, r: m.r }); requestAnimationFrame(() => gridRef.current?.querySelector(`[data-k="${m.key}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })); }}
          onHits={setHits} onWrite={(u) => { history.ownStep(); writeCells(u); history.ownStep(); }} onDone={(t) => toast(t)}
          onClose={() => { setFinding(null); gridRef.current?.focus(); }} />
      )}
      <div className="formula-bar">
        <input className="cell-name" aria-label="Name box" value={nameBox ?? selName ?? selText} onFocus={(e) => { setNameBox(selName ?? selText); requestAnimationFrame(() => e.target.select()); }}
          onChange={(e) => setNameBox(e.target.value)} onBlur={() => setNameBox(null)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (goTo(nameBox || '')) setNameBox(null); } if (e.key === 'Escape') { setNameBox(null); gridRef.current?.focus(); } }} />
        <span className="fx">fx</span>
        <input
          aria-label="Cell contents" readOnly={readOnly}
          value={editing ? draft : cells[selKey] ?? ''}
          onFocus={() => !editing && startEdit(undefined, 'bar')}
          onChange={(e) => setDraft(e.target.value)} onSelect={assist.track}
          onKeyDown={(e) => {
            if (assist.handleKey(e)) return;
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(0, 1, true); }
            if (e.key === 'Escape') cancelEdit();
          }}
          onBlur={() => editing === 'bar' && commitEdit(0, 0)}
        />
        {selValue && typeof selValue === 'object' && selValue.error && <span className="error small">{selValue.why || describeError(selValue.error)}</span>}
        {editing === 'bar' && assist.popup}
      </div>
      <div className="sheet-body">
      <div className={`grid-wrap ${painter ? 'painting' : ''}`} ref={gridRef} onContextMenu={(e) => { if (e.target === e.currentTarget) openMenu(e, 'cell'); }} tabIndex={0} onKeyDown={onGridKey} onCopy={onCopy} onCut={onCut} onPaste={onPaste}>
        <table className="grid" role="grid" aria-label={sheet.name}>
          <thead>
            <tr><th className="corner" />{Array.from({ length: cols }, (_, c) => (
              <th key={c} className={`${inGroup('col', c) ? 'grouped' : ''} ${c >= range.c1 && c <= range.c2 ? 'hl' : ''} ${c < frozen.cols ? 'frozen-c' : ''} ${c === frozen.cols - 1 ? 'freeze-edge-r' : ''}`}
                style={{ width: widthOf(c), minWidth: widthOf(c), maxWidth: widthOf(c), ...(c < frozen.cols && { left: stick.left[c] }), ...(hiddenCols.has(c) && { display: 'none' }) }}
                onMouseDown={(e) => { if (e.button === 0) pickCol(c, e); }}
                onContextMenu={(e) => { if (!(isWholeCols && c >= range.c1 && c <= range.c2)) pickCol(c, { shiftKey: false }); openMenu(e, 'col'); }}>
                {colName(c)}
                {groupToggle.col.has(c) && <GroupToggle group={groupToggle.col.get(c)} onToggle={readOnly ? null : () => flipGroup('col', groupToggle.col.get(c).from)} />}
                {unhideAt.col.has(c) && <UnhideButton run={unhideAt.col.get(c)} axis="col" onShow={readOnly ? null : (a, b) => hideSpan('col', a, b, true)} />}
                {!readOnly && <span className="col-resize" role="separator" aria-orientation="vertical" aria-label={`Resize column ${colName(c)}`} title="Drag to resize, double-click to fit"
                  onPointerDown={startResize(c)} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); fitColumn(c); }} />}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (hidden.has(r) ? null : (
              <tr key={r} className={`${hidden.has(r + 1) || hidden.has(r - 1) ? 'next-to-hidden' : ''} ${rowH(r) ? 'sized' : ''}`} style={rowH(r) ? { height: rowH(r), '--rh': `${rowH(r) - 4}px` } : undefined}>
                <th className={`${inGroup('row', r) ? 'grouped' : ''} ${r >= range.r1 && r <= range.r2 ? 'hl' : ''} ${r < frozen.rows ? 'frozen-r' : ''} ${r === frozen.rows - 1 ? 'freeze-edge-b' : ''}`}
                  style={r < frozen.rows ? { top: stick.top[r] } : undefined} onMouseDown={(e) => { if (e.button === 0) pickRow(r, e); }}
                  onContextMenu={(e) => { if (!(isWholeRows && r >= range.r1 && r <= range.r2)) pickRow(r, { shiftKey: false }); openMenu(e, 'row'); }}>{r + 1}
                  {groupToggle.row.has(r) && <GroupToggle group={groupToggle.row.get(r)} onToggle={readOnly ? null : () => flipGroup('row', groupToggle.row.get(r).from)} />}
                  {unhideAt.row.has(r) && <UnhideButton run={unhideAt.row.get(r)} axis="row" onShow={readOnly ? null : (a, b) => hideSpan('row', a, b, true)} />}
                  {!readOnly && <span className="row-resize" role="separator" aria-orientation="horizontal" aria-label={`Resize row ${r + 1}`} title="Drag to resize, double-click for the standard height"
                    onPointerDown={startRowResize(r)} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); setRowHeight(r, r, null); }} />}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const k = cellKey(c, r);
                  if (layout.covered.has(k)) return null; // drawn by its merge's top-left cell
                  if (hiddenCols.has(c) && !layout.spans.has(k)) return <td key={k} data-k={k} style={{ display: 'none' }} />;
                  const span = layout.spans.get(k);
                  const spanProps = span ? { colSpan: span.colSpan, rowSpan: span.rowSpan } : {};
                  const isSel = c === sel.c && r === sel.r;
                  if (isSel && editing === 'cell') {
                    return (
                      <td key={k} data-k={k} {...spanProps} className={`sel editing ${frozenClass(c, r)}`} style={{ maxWidth: span ? undefined : widthOf(c), ...stickyStyle(c, r) }}>
                        <input autoFocus value={draft} aria-label={`Edit ${k}`} onChange={(e) => setDraft(e.target.value)} onSelect={assist.track}
                          onKeyDown={(e) => {
                            if (assist.handleKey(e)) return;
                            if (e.key === 'Enter') { e.preventDefault(); commitEdit(0, e.shiftKey ? -1 : 1, true); }
                            else if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? -1 : 1, 0, true); }
                            else if (e.key === 'Escape') cancelEdit();
                          }}
                          onBlur={() => editing === 'cell' && commitEdit(0, 0)} />
                        {assist.popup}
                      </td>
                    );
                  }
                  const raw = cells[k];
                  const v = evaluate(k); // an empty cell can show part of a formula's array (spilled)
                  const spilledFrom = raw === undefined ? evaluate.spilledFrom?.(k) : null;
                  const isErr = v && typeof v === 'object';
                  const fmt = formats[k];
                  const vd = validations.length ? validationAt(validations, k) : null;
                  const broken = vd?.type === 'rule' && breaksRule(vd, k, v, evaluate.formulaAt);
                  return (
                    <td key={k} data-k={k} {...spanProps} style={{ maxWidth: span ? undefined : widthOf(c), ...stickyStyle(c, r), ...bandStyle(bands, c, r, fmt), ...cellStyle(fmt), ...(fmt?.num === 'custom' && codeColour(v, fmt) && { color: codeColour(v, fmt) }), ...(rules.length && ruleStyle(rules, k, v, ruleCtx)), ...(theirs.has(k) && { boxShadow: `${isSel ? 'inset 0 0 0 2px var(--accent), ' : ''}inset 0 0 0 ${isSel ? 4 : 2}px ${theirs.get(k).color}` }) }}
                      title={broken ? `Not valid: ${vd.message || describeCheck(vd.check)}` : notes[k] ? `Note: ${notes[k]}` : theirs.has(k) ? `${theirs.get(k).name} is here` : commented.has(k) ? 'Has comments' : spilledFrom ? `From the formula in ${spilledFrom}` : undefined}
                      className={`${frozenClass(c, r)} ${spilledFrom ? 'spilled' : ''} ${vd ? `has-${vd.type}` : ''} ${broken ? 'invalid' : ''} ${commented.has(k) ? 'commented' : ''} ${isSel ? 'sel' : ''} ${inRange(c, r) && anchor ? 'range' : ''} ${typeof v === 'number' ? 'num' : ''} ${isErr ? 'err' : ''} ${hits?.keys.has(k) ? (hits.current === k ? 'find-current' : 'find-hit') : ''} ${!readOnly && guardBoxes.length && guarded(c, r) ? 'guarded' : ''} ${inFill(c, r) ? 'fill-preview' : ''}`}
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
                        : evaluate.imageOf?.(k) ? <CellPicture image={evaluate.imageOf(k)} base={`/api/files/${file.id}`} label={`Picture in ${k}`} />
                        : evaluate.sparkOf?.(k) ? <Sparkline spark={evaluate.sparkOf(k)} />
                        : evaluate.linkOf?.(k) ? <a className="cell-link" href={evaluate.linkOf(k)} target="_blank" rel="noopener noreferrer" title={evaluate.linkOf(k)} onDoubleClick={(e) => e.preventDefault()}>{formatNumber(v, fmt) ?? display(v)}</a>
                        : vd?.type === 'list' && chipColour(vd, display(v)) ? <span className="cell-chip" style={{ background: chipColour(vd, display(v)) }}>{formatNumber(v, fmt) ?? display(v)}</span>
                        : fmt?.rot ? <span className={`cell-rot rot-${fmt.rot}`}>{formatNumber(v, fmt) ?? display(v)}</span>
                        : formatNumber(v, fmt) ?? display(v)}
                      {vd?.type === 'list' && !readOnly && (
                        <button type="button" className="cell-drop" tabIndex={-1} aria-label={`Choices for ${k}`}
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (editing) commitEdit(0, 0); setAnchor(null); setSel({ c, r }); setPicker({ key: k }); }}>▾</button>
                      )}
                      {fArea && r === fArea.r1 && c >= fArea.c1 && c <= fArea.c2 && (
                        <button type="button" className={`filter-btn ${columnFiltered(filter, colName(c)) ? 'on' : ''}`} tabIndex={-1} aria-label={`Filter ${colName(c)}`}
                          title={columnFiltered(filter, colName(c)) ? `Filtered${filter.cond?.[colName(c)] ? `: ${describeCondition(filter.cond[colName(c)])}` : ''}` : 'Filter and sort'}
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); if (editing) commitEdit(0, 0); setFilterMenu({ c }); }}>{columnFiltered(filter, colName(c)) ? '⏷' : '▾'}</button>
                      )}
                      {commented.has(k) && <span className="cell-comment" aria-hidden="true" />}
                      {notes[k] && <span className="cell-note" aria-hidden="true" />}
                    </td>
                  );
                })}
              </tr>
            )))}
          </tbody>
        </table>
        {handleAt && <span className="fill-handle" style={{ left: handleAt.left, top: handleAt.top }} onMouseDown={startFill} title="Drag to fill (Ctrl+D fills down, Ctrl+R right)" aria-hidden="true" />}
        <div className="chart-layer">
          {Object.entries(charts).map(([cid, ch]) => (
            <ChartCard key={cid} chart={ch} value={evaluate} skipRow={(r) => hidden.has(r)} canEdit={!readOnly}
              onChange={(next) => writeChart(cid, next)}
              onEdit={() => setDialog({ type: 'chart', chart: { ...ch, id: cid } })}
              onDelete={() => writeChart(cid, null)} />
          ))}
          {Object.entries(slicers).map(([id, sl]) => {
            const g = parseRange(sl.range);
            if (!g) return null;
            const headings = Array.from({ length: g.c2 - g.c1 + 1 }, (_, i) => ({ col: colName(g.c1 + i), name: display(evaluate(cellKey(g.c1 + i, g.r1))) }));
            return (
              <SlicerCard key={id} slicer={sl} heading={headings.find((h) => h.col === sl.col)?.name || `Column ${sl.col}`} headings={headings} canEdit={!readOnly}
                values={columnValues(slicerAsFilter(sl), cells, evaluate, colIndex(sl.col))}
                onChange={(next) => writeSlicer(id, next)} onDelete={() => writeSlicer(id, null)} />
            );
          })}
        </div>
      </div>
      {panel && <CommentsPanel fileId={file.id} threads={threads} canEdit={canComment} active={thread} setActive={setThread} pending={pending}
        onShow={goToCell} labelOf={where} onClose={() => { setPending(null); setPanel(false); }} />}
      </div>
      <div className="sheet-tabs">
        {stats && <div className="sel-stats small" role="status" aria-label="Selection">
          {stats.numbers > 0 ? <>Sum: <strong>{display(stats.sum)}</strong> · Average: <strong>{display(Math.round(stats.average * 1e6) / 1e6)}</strong> · Min: {display(stats.min)} · Max: {display(stats.max)} · </> : null}Count: <strong>{stats.count}</strong>
        </div>}
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
      {notes[selKey] && !editing && !noteEdit && (
        <div className="note-bubble" role="note" aria-label={`Note on ${selKey}`} style={(() => { const r = gridRef.current?.querySelector(`[data-k="${selKey}"]`)?.getBoundingClientRect(); return r ? { left: r.right + 4, top: r.top } : { display: 'none' }; })()}>{notes[selKey]}</div>
      )}
      {noteEdit && <NoteEditor at={noteEdit} onClose={() => { setNoteEdit(null); gridRef.current?.focus(); }} onSave={(text) => { saveNote(noteEdit.key, text); setNoteEdit(null); gridRef.current?.focus(); }} />}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} label={ctx.kind === 'row' ? 'Row actions' : ctx.kind === 'col' ? 'Column actions' : 'Cell actions'} onClose={closeCtx} />}
      {dialog?.type === 'rules' && (
        <RulesDialog rules={rules} defaultRange={anchor ? rangeText(range) : rangeText(dataRegion(sel, (c, r) => cells[cellKey(c, r)] !== undefined && cells[cellKey(c, r)] !== ''))}
          onChange={(next) => writeSheet(() => ({ rules: next.length ? next : null }))} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      )}
      {dialog?.type === 'validation' && (
        <ValidationDialog validations={validations} existing={existingValues} resolve={(src) => choicesFrom(src, valueOf)}
          defaultRange={anchor ? rangeText(range) : rangeText({ c1: sel.c, c2: sel.c, r1: sel.r, r2: sel.r })}
          onChange={(next) => writeSheet(() => ({ validations: next.length ? next : null }))} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      )}
      {filterMenu && fArea && (() => {
        const td = gridRef.current?.querySelector(`[data-k="${cellKey(filterMenu.c, fArea.r1)}"]`);
        if (!td) return null;
        const col = colName(filterMenu.c);
        const done = () => { setFilterMenu(null); gridRef.current?.focus(); };
        return <FilterMenu anchor={td} column={col} values={columnValues(filter, cells, evaluate, filterMenu.c)} hidden={filter.hidden?.[col] || []} cond={filter.cond?.[col]} onClose={done}
          onApply={(list, cond) => {
            writeSheet((s) => {
              const conds = { ...(s.filter?.cond || {}) };
              if (cond) conds[col] = cond; else delete conds[col];
              const { cond: _old, ...rest } = s.filter || {};
              return { filter: { ...rest, hidden: { ...(s.filter?.hidden || {}), [col]: list }, ...(Object.keys(conds).length && { cond: conds }) } };
            });
            done();
          }}
          onSort={(desc) => { sortBy({ range: fArea, by: filterMenu.c, desc, header: true }); done(); }} />;
      })()}
      {picker && (() => {
        const vd = validationAt(validations, picker.key);
        const td = gridRef.current?.querySelector(`[data-k="${picker.key}"]`);
        if (!vd || vd.type !== 'list' || !td) return null;
        const done = () => { setPicker(null); gridRef.current?.focus(); };
        return <ChoicePicker anchor={td} values={withChoices(vd, valueOf).values || []} current={cells[picker.key] ?? ''} onClose={done} onPick={(x) => { writeCells({ [picker.key]: x }); done(); }} />;
      })()}
      {dialog?.type === 'print' && (
        <PrintDialog hasSelection={range.c1 !== range.c2 || range.r1 !== range.r2} onClose={() => setDialog(null)} onPrint={(o) => {
          const area = o.what === 'selection' ? range : usedArea([...Object.keys(cells).filter((k) => cells[k] !== '' && cells[k] != null), ...(evaluate.spilledKeys?.() || [])]);
          if (!area) { toast('There is nothing on this sheet to print'); return; }
          setDialog(null);
          printHtml(sheetPrintHtml({
            title: `${file.name} - ${sheet.name}`, area, text: shown,
            style: (k) => { const m = /^([A-Z]+)(\d+)$/.exec(k); return { ...(m && bandStyle(bands, colIndex(m[1]), Number(m[2]) - 1, formats[k])), ...cellStyle(formats[k]), ...(rules.length && ruleStyle(rules, k, evaluate(k), ruleCtx)) }; },
            layout, hiddenRows: hidden, hiddenCols, width: widthOf, gridlines: o.gridlines, landscape: o.landscape, paper: o.paper,
          }));
        }} />
      )}
      {dialog?.type === 'names' && (
        <NamesDialog names={names} initial={dialog.initial} canEdit={!readOnly} onClose={() => { setDialog(null); gridRef.current?.focus(); }}
          onSave={(next) => writeSheet(() => ({ names: Object.keys(next).length ? next : undefined }))}
          onGo={(t) => { setDialog(null); goTo(t); }} />
      )}
      {dialog?.type === 'functions' && (
        <FunctionsDialog functions={data.functions} canEdit={!readOnly} onClose={() => { setDialog(null); gridRef.current?.focus(); }}
          onSave={(next) => { const cur = dataRef.current; const { functions, ...rest } = cur; commitData(next.length ? { ...rest, functions: next } : rest); }} />
      )}
      {dialog?.type === 'mailmerge' && <MailMergeDialog cells={cells} shown={shown} from={mail?.address || user.username} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />}
      {dialog?.type === 'protect' && (
        <ProtectDialog fileId={file.id} sheetName={sheet.name} list={sheet.protected} initial={dialog.initial} me={user.id} ownerId={file.owner_id} ownerName={file.owner_name}
          canEdit={!readOnly} onClose={() => { setDialog(null); gridRef.current?.focus(); }}
          onSave={(next) => writeSheet(() => ({ protected: next.length ? next : undefined }))} />
      )}
      {dialog?.type === 'protect-warn' && (
        <ConfirmModal title="Change protected cells?" confirm="Change anyway" danger={false}
          message={`${dialog.list.map(({ p, sheet: sn }) => `${p.range ? `${sn}!${p.range}` : `The sheet “${sn}”`}${p.desc ? ` (${p.desc})` : ''}`).join(', ')} ${dialog.list.length > 1 ? 'are' : 'is'} marked to be changed with care.`}
          onClose={() => { setDialog(null); gridRef.current?.focus(); }}
          onConfirm={() => { for (const { p } of dialog.list) warned.current.add(p.id); commitData(dialog.next); }} />
      )}
      {dialog?.type === 'sort' && (() => { const g = sortTarget(); return (
        <SortDialog initial={{ range: g, by: sel.c }} header={looksLikeHeader(g, evaluate)} value={evaluate} onSort={sortBy} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      ); })()}
      {dialog?.type === 'rowheight' && (
        <PromptModal title={dialog.a === dialog.b ? `Height of row ${dialog.a + 1}` : `Height of rows ${dialog.a + 1}–${dialog.b + 1}`} label={`Height in pixels (${MIN_H}–${MAX_H}; the standard is ${DEFAULT_H})`}
          initial={String(heightOf(sheet?.rowHeights, dialog.a) || DEFAULT_H)}
          onSubmit={(v) => { const n = Number(v); if (!Number.isFinite(n) || n < MIN_H || n > MAX_H) throw new Error(`Type a number from ${MIN_H} to ${MAX_H}`); setRowHeight(dialog.a, dialog.b, n); }}
          onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      )}
      {dialog?.type === 'picture' && (
        <PictureCellDialog cell={dialog.key} parentId={file.parent_id}
          onPick={(formula) => { writeCells({ [dialog.key]: formula }); setDialog(null); gridRef.current?.focus(); }}
          onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      )}
      {dialog?.type === 'compare-pick' && <DrivePicker title="Compare with…" empty="No spreadsheets found."
        accept={(x) => x.id !== file.id && (x.kind === 'sheet' || (x.kind === 'file' && /\.(xlsx|ods|csv)$/i.test(x.name)))}
        onClose={() => { setDialog(null); gridRef.current?.focus(); }}
        onPick={async (f) => {
          setDialog({ type: 'compare-loading' });
          try { setDialog({ type: 'compare', other: await get(`/files/${f.id}/as-sheet`) }); } catch (e) { setDialog(null); toast(e.message, 'error'); }
        }} />}
      {dialog?.type === 'compare' && <CompareSheets name={file.name} other={dialog.other} current={dataRef.current} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />}
      {dialog?.type === 'goalseek' && (
        <GoalSeekDialog sheets={data.sheets || [{ name: 'Sheet1', cells, names }]} index={data.sheets ? Math.min(active, data.sheets.length - 1) : 0} imports={{ book: importBook, web: importWeb, depth: 0 }} functions={data.functions}
          setCell={typeof cells[selKey] === 'string' && cells[selKey].startsWith('=') ? selKey : ''}
          onClose={() => { setDialog(null); gridRef.current?.focus(); }}
          onKeep={(key, value) => {
            const lock = protectionsAt(sheet, key).find((p) => !p.warn && !mayEdit(p, user.id, file.owner_id));
            if (lock) { toast(`${key} is protected${lock.desc ? ` (${lock.desc})` : ''}. Only some people can change it.`, 'error'); return; }
            writeCells({ [key]: String(value) }); setDialog(null); toast(`${key} set to ${display(value)}`); gridRef.current?.focus(); }} />
      )}
      {dialog?.type === 'colstats' && (() => {
        // How far the sheet's data goes (cells and formula spills), so empty rows below don't count.
        const keys = [...Object.keys(cells).filter((k) => cells[k] !== '' && cells[k] != null), ...(evaluate.spilledKeys?.() || [])];
        const used = usedArea(keys);
        return <ColumnStatsDialog value={evaluate} startCol={dialog.c} lastRow={used ? used.r2 : 0} lastCol={Math.max(used ? used.c2 : 0, dialog.c)} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />;
      })()}
      {dialog?.type === 'bands' && (
        <BandsDialog bands={bands} takenNames={[...(data?.sheets || []).flatMap((s, i) => (s.bands || []).filter((b) => b.name).map((b) => b.name)), ...Object.keys(names || {})]} defaultRange={rangeText(anchor ? range : sortTarget())} onClose={() => { setDialog(null); gridRef.current?.focus(); }}
          onSave={(next) => { writeSheet(() => ({ bands: next.length ? next : undefined })); setDialog(null); gridRef.current?.focus(); }} />
      )}
      {dialog?.type === 'dedupe' && (() => { const g = sortTarget(); return (
        <DedupeDialog range={g} header={looksLikeHeader(g, evaluate)} onClose={() => { setDialog(null); gridRef.current?.focus(); }} onRun={(o) => { setDialog(null); dedupe(g, o); }} />
      ); })()}
      {dialog?.type === 'split' && (() => { const g = anchor ? range : sortTarget(); const col = anchor ? { ...g, c2: g.c1 } : { ...g, c1: sel.c, c2: sel.c }; return (
        <SplitDialog range={col} onClose={() => { setDialog(null); gridRef.current?.focus(); }} onRun={(o) => { setDialog(null); split(col, o); }} />
      ); })()}
      {dialog?.type === 'chart' && (
        <ChartDialog initial={dialog.chart} value={evaluate} onClose={() => { setDialog(null); gridRef.current?.focus(); }}
          onSave={({ id: cid, newId, ...ch }) => writeChart(cid || newId, ch)} />
      )}
      {dialog?.type === 'share' && <ShareDialog file={file} onClose={() => setDialog(null)} />}
      {dialog?.type === 'history' && <VersionHistory file={file} canEdit={!readOnly} onClose={() => setDialog(null)} renderPreview={(content) => <SheetPreview content={content} />} renderChanges={(content) => <SheetChanges before={content} after={dataRef.current} />} />}
      {dialog?.type === 'pivot' && (
        <PivotDialog headings={dialog.headings} spec={dialog.spec} editing={dialog.index !== null} table={pivotSource(dialog.spec)}
          source={`${dialog.spec.source}!${colName(dialog.spec.c1)}${dialog.spec.r1 + 1}:${colName(dialog.spec.c2)}`}
          onSave={(spec) => savePivot(spec, { index: dialog.index })} onClose={() => { setDialog(null); gridRef.current?.focus(); }} />
      )}
      {dialog?.type === 'rename-sheet' && (
        <PromptModal title="Rename sheet" label="Sheet name" initial={data.sheets[dialog.index].name} onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const cur = dataRef.current;
            const old = cur.sheets[dialog.index].name;
            const fresh = name.slice(0, 50);
            // Pivot tables and formulas (Sheet1!A1) follow the sheet's new name.
            const renamed = (s) => {
              const cells = {}; let n = 0;
              for (const [k, v] of Object.entries(s.cells || {})) { cells[k] = renameSheetRefs(v, old, fresh); if (cells[k] !== v) n++; }
              const validations = s.validations?.map((v) => (v.source ? { ...v, source: renameSource(v.source, old, fresh) } : v)); // dropdowns follow too
              return { ...s, ...(n && { cells }), ...(validations && { validations }) };
            };
            commitData({ ...cur, sheets: cur.sheets.map((s0, i) => { const s = renamed(s0); return i === dialog.index ? { ...s, name: fresh } : s.pivot?.source === old ? { ...s, pivot: { ...s.pivot, source: fresh } } : s; }) });
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
/** Writing a cell's note: Ctrl+Enter (or clicking away) keeps it, Esc leaves it as it was; empty removes it. */
function NoteEditor({ at, onSave, onClose }) {
  const [text, setText] = useState(at.text);
  const done = useRef(false);
  const finish = (save) => { if (done.current) return; done.current = true; if (save) onSave(text); else onClose(); };
  return (
    <div className="note-bubble note-edit" style={{ left: Math.min(at.x, window.innerWidth - 260), top: Math.min(at.y, window.innerHeight - 160) }}>
      <textarea autoFocus aria-label={`Note on ${at.key}`} rows={4} maxLength={2000} value={text} placeholder="Write a note…" onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); } }} />
      <div className="muted small">{at.key} · Ctrl+Enter to keep, Esc to cancel</div>
    </div>
  );
}

function FormatBar({ sample, painter, onPaint, fmt, onChange, onBorders, onMerge, merged, onComment, onChart, onSort, onRules, onValidation, onPivot, filterOn, onFilter, onSlicer, history }) {
  const keep = (e) => e.preventDefault(); // buttons don't take focus from the grid
  const Toggle = ({ k, label, title, children }) => (
    <button type="button" className={`tb ${fmt[k] ? 'on' : ''}`} aria-pressed={!!fmt[k]} aria-label={label} title={title} onMouseDown={keep} onClick={() => onChange({ [k]: !fmt[k] })}>{children}</button>
  );
  const align = fmt.align || 'auto';
  const [open, setOpen] = useState(false); // phones: the toolbar folds away behind one button
  const [customOpen, setCustomOpen] = useState(false); // the Custom number format window
  return (
    <div className={`sheet-toolbar foldable ${open ? 'open' : ''}`} role="toolbar" aria-label="Cell formatting">
      <button type="button" className="tb tb-fold" aria-expanded={open} onMouseDown={keep} onClick={() => setOpen(!open)}>{open ? 'Hide formatting ▴' : 'Formatting ▾'}</button>
      <button type="button" className="tb" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.canUndo} onMouseDown={keep} onClick={history.undo}>↶</button>
      <button type="button" className="tb" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!history.canRedo} onMouseDown={keep} onClick={history.redo}>↷</button>
      <button type="button" className={`tb ${painter ? 'on' : ''}`} aria-label="Paint format" aria-pressed={!!painter} onMouseDown={keep}
        title={painter?.sticky ? 'Paint format is on: select cells to give them this formatting (Esc to stop)' : 'Paint format: copy the selected cells’ formatting, then select cells to apply it (double-click to keep it on)'}
        onClick={(e) => { if (e.detail <= 1) onPaint(false); }} onDoubleClick={() => onPaint(true)}>🖌</button>
      <span className="sep" />
      <Toggle k="b" label="Bold" title="Bold (Ctrl+B)"><b>B</b></Toggle>
      <Toggle k="i" label="Italic" title="Italic (Ctrl+I)"><i>I</i></Toggle>
      <Toggle k="u" label="Underline" title="Underline (Ctrl+U)"><u>U</u></Toggle>
      <Toggle k="s" label="Strikethrough" title="Strikethrough (Alt+Shift+5)"><s>S</s></Toggle>
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
      <select className="tb-select" aria-label="Text rotation" title="Text rotation: tilt or turn the text (for narrow headings)" value={fmt.rot || ''} onMouseDown={keep} onChange={(e) => onChange({ rot: e.target.value || null })}>
        <option value="">⟲ None</option>
        {ROTATIONS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      <select className="tb-select" aria-label="Vertical alignment" title="Vertical alignment: where the text sits in a taller row" value={fmt.va || ''} onMouseDown={keep} onChange={(e) => onChange({ va: e.target.value || null })}>
        <option value="">↕ Middle</option>
        {VALIGNS.filter(([v]) => v !== 'middle').map(([v, n]) => <option key={v} value={v}>{v === 'top' ? '⤒' : '⤓'} {n}</option>)}
      </select>
      <Toggle k="wrap" label="Wrap text" title="Wrap text onto more lines in the cell">↵</Toggle>
      <button type="button" className={`tb ${merged ? 'on' : ''}`} aria-pressed={merged} aria-label={merged ? 'Unmerge cells' : 'Merge cells'} title={merged ? 'Unmerge cells' : 'Merge the selected cells into one'} onMouseDown={keep} onClick={onMerge}>⊞</button>
      <select className="tb-select" aria-label="Borders" title="Borders around the selected cells" value="" onChange={(e) => { if (e.target.value) onBorders(e.target.value); }}>
        <option value="">Borders…</option>
        {BORDERS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      <span className="sep" />
      {customOpen && <CustomFormatDialog initial={fmt.code} sample={sample} onClose={() => setCustomOpen(false)} onSave={(code) => { setCustomOpen(false); onChange({ num: 'custom', code, dp: null }); }} />}
      {fmt.num === 'custom' && <button type="button" className="tb" aria-label="Edit format code" title={`Format code: ${fmt.code}`} onMouseDown={keep} onClick={() => setCustomOpen(true)}>✎</button>}
      <select className="tb-select" aria-label="Number format" title="Number format" value={fmt.num || ''} onChange={(e) => (e.target.value === 'custom' ? setCustomOpen(true) : onChange({ num: e.target.value, dp: null }))}>
        {NUMBER_FORMATS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      {fmt.num === 'currency' && (
        <select className="tb-select" aria-label="Currency" value={fmt.cur || 'MYR'} onChange={(e) => onChange({ cur: e.target.value, dp: null })}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      {fmt.num === 'date' && (
        <select className="tb-select" aria-label="Date style" value={fmt.ds || 'medium'} onChange={(e) => onChange({ ds: e.target.value })}>
          {DATE_STYLES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
      )}
      {fmt.num && fmt.num !== 'date' && <>
        <button type="button" className="tb" aria-label="Fewer decimals" title="Fewer decimals" onMouseDown={keep} onClick={() => onChange({ dp: Math.max(0, decimals(fmt) - 1) })}>.0←</button>
        <button type="button" className="tb" aria-label="More decimals" title="More decimals" onMouseDown={keep} onClick={() => onChange({ dp: Math.min(10, decimals(fmt) + 1) })}>.00→</button>
      </>}
      <span className="sep" />
      <button type="button" className="tb" aria-label="Clear formatting" title="Clear formatting" onMouseDown={keep}
        onClick={() => onChange({ b: null, i: null, u: null, s: null, wrap: null, bd: null, color: null, fill: null, align: null, va: null, rot: null, num: null })}>Tx</button>
      <span className="sep" />
      <button type="button" className="tb labelled" aria-label="Conditional formatting" title="Colour cells by their value" onMouseDown={keep} onClick={onRules}><RulesGlyph /> Rules</button>
      <button type="button" className={`tb labelled ${filterOn ? 'on' : ''}`} aria-label={filterOn ? 'Remove filter' : 'Create a filter'} aria-pressed={filterOn} title={filterOn ? 'Remove the filter (shows every row)' : 'Filter rows by their values'} onMouseDown={keep} onClick={onFilter}><FilterGlyph /> Filter</button>
      <button type="button" className="tb labelled" aria-label="Add a slicer" title="A control on the sheet that filters the table around the cursor by its column" onMouseDown={keep} onClick={onSlicer}>⧩ Slicer</button>
      <button type="button" className="tb labelled" aria-label="Data validation" title="Dropdowns, tick boxes and rules for what cells may hold" onMouseDown={keep} onClick={onValidation}>▾ Validation</button>
      <button type="button" className="tb labelled" aria-label="Sort range" title="Sort rows by a column" onMouseDown={keep} onClick={onSort}><SortGlyph /> Sort</button>
      <button type="button" className="tb labelled" aria-label="Insert chart" title="Chart of the selected cells" onMouseDown={keep} onClick={onChart}><Icon name="chart" size={18} /> Chart</button>
      <button type="button" className="tb labelled" aria-label="Pivot table" title="Summarise the table around the cursor on a new sheet" onMouseDown={keep} onClick={onPivot}>⊞ Pivot</button>
      <button type="button" className="tb labelled" aria-label="Add comment" title="Comment on this cell (Ctrl+Alt+M)" onMouseDown={keep} onClick={onComment}><Icon name="chat" size={18} /> Comment</button>
    </div>
  );
}

function AlignGlyph({ to }) {
  const lines = to === 'center' ? [[4, 16], [7, 10], [4, 16], [7, 10]] : to === 'right' ? [[4, 16], [10, 10], [4, 16], [10, 10]] : [[4, 16], [4, 10], [4, 16], [4, 10]];
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">{lines.map(([x, w], i) => <rect key={i} x={x} y={5 + i * 4} width={w} height="2" rx="1" fill="currentColor" />)}</svg>;
}

function FilterGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5h18l-7 8v6l-4-2v-4L3 5z" /></svg>;
}

function SortGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z" /></svg>;
}

function RulesGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" opacity=".35" /><path fill="currentColor" d="M13 13h7v7h-7z" /></svg>;
}

/** The small button on a heading next to hidden rows or columns, which shows them again. */
function UnhideButton({ run, axis, onShow }) {
  const name = axis === 'row' ? (n) => String(n + 1) : colName;
  const what = run.a === run.b ? `${axis === 'row' ? 'row' : 'column'} ${name(run.a)}` : `${axis === 'row' ? 'rows' : 'columns'} ${name(run.a)}–${name(run.b)}`;
  return (
    <button type="button" className={`unhide-btn ${axis} ${run.side}`} tabIndex={-1} disabled={!onShow} aria-label={`Show hidden ${what}`} title={`Show hidden ${what}`}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onShow?.(run.a, run.b); }}>{axis === 'row' ? '⋯' : '⋮'}</button>
  );
}

/** What to print, and how. */
function PrintDialog({ hasSelection, onClose, onPrint }) {
  const [o, setO] = useState({ what: hasSelection ? 'selection' : 'sheet', gridlines: true, landscape: false, paper: 'A4' });
  return (
    <Modal title="Print or save as PDF" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); onPrint(o); }}>
        <div className="row wrap" role="radiogroup" aria-label="What to print">
          <label className="check"><input type="radio" name="what" checked={o.what === 'sheet'} onChange={() => setO({ ...o, what: 'sheet' })} /> This sheet</label>
          <label className="check"><input type="radio" name="what" checked={o.what === 'selection'} disabled={!hasSelection} onChange={() => setO({ ...o, what: 'selection' })} /> Selected cells</label>
        </div>
        <div className="row wrap">
          <label className="field"><span>Paper</span><select value={o.paper} onChange={(e) => setO({ ...o, paper: e.target.value })}><option>A4</option><option>Letter</option></select></label>
          <label className="field"><span>Orientation</span><select value={o.landscape ? 'landscape' : 'portrait'} onChange={(e) => setO({ ...o, landscape: e.target.value === 'landscape' })}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
        </div>
        <label className="check"><input type="checkbox" checked={o.gridlines} onChange={(e) => setO({ ...o, gridlines: e.target.checked })} /> Gridlines</label>
        <p className="muted small" style={{ margin: 0 }}>Hidden and filtered-out rows and columns are left out. Choose “Save as PDF” in the print dialog for a PDF.</p>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Print</button></div>
      </form>
    </Modal>
  );
}

/** A SPARKLINE: the range's numbers as a little line or columns filling the cell. */
function Sparkline({ spark }) {
  const vals = spark.values;
  const nums = vals.filter((x) => x !== null);
  const lo = Math.min(0, ...nums), hi = Math.max(...nums), span = hi - lo || 1;
  const W = 100, H = 30, n = vals.length;
  const y = (x) => H - 2 - ((x - lo) / span) * (H - 4);
  return (
    <svg className="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Sparkline of ${nums.length} values`}>
      {spark.type === 'column'
        ? vals.map((x, i) => x !== null && <rect key={i} x={(i * W) / n + 0.5} width={Math.max(1, W / n - 1)} y={Math.min(y(x), y(0))} height={Math.max(1, Math.abs(y(0) - y(x)))} fill={x < 0 ? '#d93025' : 'var(--accent)'} />)
        : <polyline fill="none" stroke="var(--accent)" strokeWidth="1.6" vectorEffect="non-scaling-stroke"
            points={vals.map((x, i) => (x === null ? null : `${n === 1 ? W / 2 : (i * W) / (n - 1)},${y(x)}`)).filter(Boolean).join(' ')} />}
    </svg>
  );
}

/** The − / + of a group of rows or columns, on the heading just after it. */
function GroupToggle({ group, onToggle }) {
  const n = group.to - group.from + 1;
  const what = group.axis === 'row' ? `rows ${group.from + 1}–${group.to + 1}` : `columns ${colName(group.from)}–${colName(group.to)}`;
  return (
    <button type="button" className="group-toggle" aria-expanded={!group.collapsed} disabled={!onToggle}
      aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} ${what}`} title={`${group.collapsed ? 'Show' : 'Hide'} the ${n} grouped ${group.axis === 'row' ? 'rows' : 'columns'}`}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggle?.(); }}>{group.collapsed ? '+' : '−'}</button>
  );
}
