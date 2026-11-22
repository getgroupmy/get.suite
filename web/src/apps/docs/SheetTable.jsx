// Docs and Slides → Insert table from a spreadsheet: pick a sheet and (optionally) a range; the cells come in as a table, as the
// sheet shows them (worked-out formulas, number formats, bold kept), the first row a header row if wanted. It's a copy:
// later changes in the spreadsheet don't follow.
import { useEffect, useState } from 'react';
import { get } from '../../api.js';
import { Modal } from '../../components/ui.jsx';

/** The table (TipTap JSON) for rows of { text, bold }. */
export function tableNode(rows, header) {
  const cell = (c, head) => ({
    type: head ? 'tableHeader' : 'tableCell',
    content: [{ type: 'paragraph', ...(c.text && { content: [{ type: 'text', text: c.text, ...(c.bold && !head && { marks: [{ type: 'bold' }] }) }] }) }],
  });
  return { type: 'table', content: rows.map((row, i) => ({ type: 'tableRow', content: row.map((c) => cell(c, header && i === 0)) })) };
}

/** onInsert({ rows: [[{ text, bold }]], header }); forSlides: no bigger than a slide's table (20 rows, 10 columns). */
export function SheetTableDialog({ file, onClose, onInsert, forSlides = false }) {
  const [info, setInfo] = useState(null); // { sheets, sheet, range, rows }
  const [sheet, setSheet] = useState(0);
  const [range, setRange] = useState('');
  const [header, setHeader] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = (s, rg) => get(`/files/${file.id}/table?sheet=${s}&range=${encodeURIComponent(rg)}${forSlides ? '&for=slides' : ''}`);
  // (the sheet names to pick from; the first sheet's cells in use, or why they can't be used)
  useEffect(() => { get(`/files/${file.id}/table?range=A1`).then((r) => { setInfo(r); load(0, '').then((x) => setInfo(x)).catch((e) => setError(e.message)); }).catch((e) => { setError(e.message); setInfo({ sheets: [] }); }); }, [file.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const insert = async () => {
    setBusy(true);
    try { const r = await load(sheet, range.trim()); onInsert({ rows: r.rows, header: header && r.rows.length > 1 }); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  const visible = (info?.sheets || []).filter((s) => !s.hidden);
  return (
    <Modal title={`Table from “${file.name}”`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !info || !visible.length} onClick={insert}>Insert table</button></>}>
      {!info && !error && <p className="muted">Loading…</p>}
      {info && <div className="form-grid">
        {visible.length > 1 && <label>Sheet <select value={sheet} onChange={(e) => { setSheet(Number(e.target.value)); setError(null); }}>
          {visible.map((s) => <option key={s.index} value={s.index}>{s.name}</option>)}</select></label>}
        <label>Cells <input value={range} onChange={(e) => { setRange(e.target.value); setError(null); }} placeholder={sheet === info.sheet && info.range ? `All in use (${info.range})` : 'All in use'} aria-describedby="sheet-table-help" /></label>
        <p id="sheet-table-help" className="muted small">A range like A1:D10, or leave it empty for all the cells in use. Hidden rows and columns are left out.</p>
        <label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is a header row</label>
        <p className="muted small">The table is a copy of the cells as they show now: later changes in the spreadsheet don’t follow.</p>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
    </Modal>
  );
}
