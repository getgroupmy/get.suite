import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { get, patch } from '../../api.js';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { jsonFromSheetDoc, applySheetJson } from '../collabsync.js';
import { useAuth } from '../../App.jsx';
import { useToast, PromptModal, ConfirmModal, Menu, Avatar } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { EditorHeader } from '../editorCommon.jsx';
import { CommentsPanel, useComments } from '../comments.jsx';
import { ChartCard, ChartDialog } from './SheetCharts.jsx';
import { dataRegion, rangeText } from './charts.js';

const SEL_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#8430ce', '#00796b', '#c2185b', '#5f6368'];
const colorFor = (id) => SEL_COLORS[[...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % SEL_COLORS.length];
import { createEvaluator, display, colName, cellKey, parseRef, shiftFormula } from './formula.js';
import { NUMBER_FORMATS, CURRENCIES, decimals, formatNumber, cellStyle, mergeFormat } from './cellformat.js';

const TEXT_COLORS = [['', 'Automatic'], ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#1a73e8', 'Blue'], ['#8430ce', 'Purple'], ['#5f6368', 'Grey']];
const FILLS = [['', 'None'], ['#fce8e6', 'Light red'], ['#fef7e0', 'Light yellow'], ['#e6f4ea', 'Light green'], ['#e8f0fe', 'Light blue'], ['#f3e8fd', 'Light purple'], ['#f1f3f4', 'Light grey']];

const MIN_ROWS = 100;
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

  // Tell the others which cell is selected.
  useEffect(() => { provider?.awareness.setLocalStateField('sel', { sheet: active, k: cellKey(sel.c, sel.r) }); }, [provider, active, sel]);

  const sheet = data?.sheets[Math.min(active, (data?.sheets.length || 1) - 1)];
  const cells = sheet?.cells || {};
  const formats = sheet?.formats || {};
  const charts = sheet?.charts || {};
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

  function commitEdit(dc = 0, dr = 0) {
    writeCells({ [cellKey(sel.c, sel.r)]: draft });
    setEditing(null);
    move(dc, dr);
    gridRef.current?.focus();
  }

  function cancelEdit() { setEditing(null); gridRef.current?.focus(); }

  function onGridKey(e) {
    if (editing) return;
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'ArrowUp') { e.preventDefault(); move(0, -1, e.shiftKey); }
    else if (k === 'ArrowDown') { e.preventDefault(); move(0, 1, e.shiftKey); }
    else if (k === 'ArrowLeft') { e.preventDefault(); move(-1, 0, e.shiftKey); }
    else if (k === 'ArrowRight') { e.preventDefault(); move(1, 0, e.shiftKey); }
    else if (k === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); }
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
  const commented = new Map(openThreads.filter((t) => (t.anchor?.sheet || 0) === active).map((t) => [t.anchor.cell, t.id]));
  const goToCell = (t) => {
    const p = parseRef(t.anchor?.cell || '');
    if (!p) return;
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
  const where = (t) => (data.sheets.length > 1 ? `${sheetName(t.anchor?.sheet || 0)} ${t.anchor?.cell}` : t.anchor?.cell || '');

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
      {!readOnly && <FormatBar fmt={formats[selKey] || {}} onChange={(change) => { writeFormats(change); gridRef.current?.focus(); }} onComment={startComment} onChart={newChart} />}
      <div className="formula-bar">
        <span className="cell-name">{anchor ? `${cellKey(range.c1, range.r1)}:${cellKey(range.c2, range.r2)}` : selKey}</span>
        <span className="fx">fx</span>
        <input
          aria-label="Cell contents" readOnly={readOnly}
          value={editing ? draft : cells[selKey] ?? ''}
          onFocus={() => !editing && startEdit(undefined, 'bar')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitEdit(0, 1); }
            if (e.key === 'Escape') cancelEdit();
          }}
          onBlur={() => editing === 'bar' && commitEdit(0, 0)}
        />
        {selValue && typeof selValue === 'object' && selValue.error && <span className="error small">{describeError(selValue.error)}</span>}
      </div>
      <div className="sheet-body">
      <div className="grid-wrap" ref={gridRef} tabIndex={0} onKeyDown={onGridKey} onCopy={onCopy} onCut={onCut} onPaste={onPaste}>
        <table className="grid" role="grid" aria-label={sheet.name}>
          <thead>
            <tr><th className="corner" />{Array.from({ length: cols }, (_, c) => <th key={c} className={c >= range.c1 && c <= range.c2 ? 'hl' : ''}>{colName(c)}</th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                <th className={r >= range.r1 && r <= range.r2 ? 'hl' : ''}>{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const k = cellKey(c, r);
                  const isSel = c === sel.c && r === sel.r;
                  if (isSel && editing === 'cell') {
                    return (
                      <td key={k} data-k={k} className="sel editing">
                        <input autoFocus value={draft} aria-label={`Edit ${k}`} onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitEdit(0, e.shiftKey ? -1 : 1); }
                            else if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? -1 : 1, 0); }
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
                  return (
                    <td key={k} data-k={k} style={theirs.has(k) ? { ...cellStyle(fmt), boxShadow: `${isSel ? 'inset 0 0 0 2px var(--accent), ' : ''}inset 0 0 0 ${isSel ? 4 : 2}px ${theirs.get(k).color}` } : cellStyle(fmt)}
                      title={theirs.has(k) ? `${theirs.get(k).name} is here` : commented.has(k) ? 'Has comments' : undefined}
                      className={`${commented.has(k) ? 'commented' : ''} ${isSel ? 'sel' : ''} ${inRange(c, r) && anchor ? 'range' : ''} ${typeof v === 'number' ? 'num' : ''} ${isErr ? 'err' : ''}`}
                      onMouseDown={(e) => {
                        if (editing) commitEdit(0, 0);
                        if (e.shiftKey) { if (!anchor) setAnchor(sel); } else setAnchor(null);
                        setSel({ c, r });
                      }}
                      onMouseEnter={(e) => { if (e.buttons === 1 && !editing) { if (!anchor) setAnchor(sel); setSel({ c, r }); } }}
                      onClick={() => { if (commented.has(k)) { setThread(commented.get(k)); setPanel(true); } }}
                      onDoubleClick={() => startEdit()}>
                      {formatNumber(v, fmt) ?? display(v)}
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
    '#VALUE!': 'Wrong type of value', '#CIRC!': 'Circular reference', '#NUM!': 'Invalid number', '#ERROR!': 'Formula parse error',
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
function FormatBar({ fmt, onChange, onComment, onChart }) {
  const keep = (e) => e.preventDefault(); // buttons don't take focus from the grid
  const Toggle = ({ k, label, title, children }) => (
    <button type="button" className={`tb ${fmt[k] ? 'on' : ''}`} aria-pressed={!!fmt[k]} aria-label={label} title={title} onMouseDown={keep} onClick={() => onChange({ [k]: !fmt[k] })}>{children}</button>
  );
  const align = fmt.align || 'auto';
  return (
    <div className="sheet-toolbar" role="toolbar" aria-label="Cell formatting">
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
      <button type="button" className="tb labelled" aria-label="Insert chart" title="Chart of the selected cells" onMouseDown={keep} onClick={onChart}><Icon name="chart" size={18} /> Chart</button>
      <button type="button" className="tb labelled" aria-label="Add comment" title="Comment on this cell (Ctrl+Alt+M)" onMouseDown={keep} onClick={onComment}><Icon name="chat" size={18} /> Comment</button>
    </div>
  );
}

function AlignGlyph({ to }) {
  const lines = to === 'center' ? [[4, 16], [7, 10], [4, 16], [7, 10]] : to === 'right' ? [[4, 16], [10, 10], [4, 16], [10, 10]] : [[4, 16], [4, 10], [4, 16], [4, 10]];
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">{lines.map(([x, w], i) => <rect key={i} x={x} y={5 + i * 4} width={w} height="2" rx="1" fill="currentColor" />)}</svg>;
}
