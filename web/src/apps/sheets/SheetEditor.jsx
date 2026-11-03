import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, patch, onLive } from '../../api.js';
import { useAuth } from '../../App.jsx';
import { useToast, PromptModal, ConfirmModal, Menu } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { useAutosave, EditorHeader } from '../editorCommon.jsx';
import { createEvaluator, display, colName, cellKey, parseRef, shiftFormula } from './formula.js';

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
  const save = useAutosave(id);
  const readOnly = file?.role === 'viewer';

  const load = useCallback(async () => {
    const { file, content } = await get(`/files/${id}/content`);
    setFile(file);
    save.setVersion(file.version);
    dataRef.current = content;
    setData(content);
    document.title = `${file.name} · Sheets`;
  }, [id, save]);

  useEffect(() => {
    load().catch((e) => { toast(e.message, 'error'); navigate('/drive'); });
    return () => { document.title = 'Workspace'; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => onLive(async (m) => {
    if (m.type !== 'content-changed' || m.id !== id || m.by === user.id) return;
    if (save.isDirty() || editing) { save.markConflict(m.by_name); return; }
    await load();
    toast(`${m.by_name} updated this spreadsheet`);
  }), [id, user.id, save, editing, load, toast]);

  const sheet = data?.sheets[Math.min(active, (data?.sheets.length || 1) - 1)];
  const cells = sheet?.cells || {};
  const evaluate = useMemo(() => createEvaluator(cells), [cells]);
  const { rows, cols } = useMemo(() => sheetSize(cells), [cells]);

  function commitData(next) {
    dataRef.current = next;
    setData(next);
    save.changed(() => dataRef.current);
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
    } else if (mod && k.toLowerCase() === 'a') { e.preventDefault(); setAnchor({ c: 0, r: 0 }); setSel({ c: cols - 1, r: rows - 1 }); }
    else if (!mod && !e.altKey && k.length === 1) { e.preventDefault(); startEdit(k); }
  }

  function onCopy(e) {
    if (editing) return;
    e.preventDefault();
    const raws = [];
    const lines = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const rawRow = [], vals = [];
      for (let c = range.c1; c <= range.c2; c++) {
        const k = cellKey(c, r);
        rawRow.push(cells[k] ?? '');
        vals.push(display(evaluate(k)));
      }
      raws.push(rawRow);
      lines.push(vals.join('\t'));
    }
    const text = lines.join('\n');
    clip.current = { text, raws, origin: { c: range.c1, r: range.r1 } };
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
      const { raws, origin } = clip.current;
      raws.forEach((row, ri) => row.forEach((raw, ci) => {
        u[cellKey(sel.c + ci, sel.r + ri)] = shiftFormula(raw, sel.c - origin.c, sel.r - origin.r);
      }));
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
  const selValue = evaluate(selKey);

  return (
    <div className="editor-page sheet-page">
      <EditorHeader
        icon="sheet" file={file} status={save.status}
        onRename={async (name) => setFile(await patch(`/files/${id}`, { name }))}
        onShare={() => setDialog({ type: 'share' })}
        menu={[
          { label: 'Download sheet as CSV', icon: 'download', onClick: exportCsv },
          !readOnly && { label: 'Import CSV as new sheet', icon: 'upload', onClick: importCsv },
        ]}
      />
      {save.conflict && (
        <div className="banner warn">
          {save.conflict} changed this spreadsheet while you were editing.
          <button className="btn small" onClick={async () => { save.resolve(); await load(); }}>Load their version</button>
          <button className="btn small" onClick={() => save.forceSave(dataRef.current)}>Keep mine</button>
        </div>
      )}
      {readOnly && <div className="banner">View only. Ask {file.owner_name} for edit access.</div>}
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
                  return (
                    <td key={k} data-k={k}
                      className={`${isSel ? 'sel' : ''} ${inRange(c, r) && anchor ? 'range' : ''} ${typeof v === 'number' ? 'num' : ''} ${isErr ? 'err' : ''}`}
                      onMouseDown={(e) => {
                        if (editing) commitEdit(0, 0);
                        if (e.shiftKey) { if (!anchor) setAnchor(sel); } else setAnchor(null);
                        setSel({ c, r });
                      }}
                      onMouseEnter={(e) => { if (e.buttons === 1 && !editing) { if (!anchor) setAnchor(sel); setSel({ c, r }); } }}
                      onDoubleClick={() => startEdit()}>
                      {display(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
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
