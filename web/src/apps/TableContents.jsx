// A CSV or TSV file shown as a table: its first row as the headings (kept in view while scrolling), the first
// 1,000 rows; a heading sorts by its column (again: the other way, a third time: as in the file), Filter rows keeps
// those with a cell containing the words; Show as text gives the file as written. `load` gives { text, truncated } as for the code viewer.
import { useEffect, useMemo, useState } from 'react';
import { separatorFor, parseTable, sortRows, filterRows } from './csvtable.js';
import CodeContents from './CodeContents.jsx';

const MAX_ROWS = 1000;

export default function TableContents({ name, load }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [asText, setAsText] = useState(false);
  const [sort, setSort] = useState(null); // { col, dir }
  const [filter, setFilter] = useState('');
  useEffect(() => {
    let live = true;
    setD(null); setError('');
    load().then((x) => live && setD(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  const table = useMemo(() => (d ? parseTable(d.text, separatorFor(name, d.text), MAX_ROWS + 1) : null), [d, name]);
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!d) return <p className="muted">Reading the file…</p>;
  const toggle = <button type="button" className="btn small" aria-pressed={asText} onClick={() => setAsText(!asText)}>{asText ? 'Show as a table' : 'Show as text'}</button>;
  if (asText) return <div className="stack-tight table-contents"><div className="row">{toggle}</div><CodeContents name={name} load={async () => d} /></div>;
  const [head = [], ...body] = table.rows;
  const shown = body.slice(0, MAX_ROWS);
  const cols = Math.max(head.length, ...shown.map((r) => r.length), 0);
  const more = table.more || body.length > MAX_ROWS || d.truncated;
  const numbered = shown.map((r, i) => { const a = [...r]; a.n = i + 2; return a; }); // each row keeps its number in the file
  const filtered = filterRows(numbered, filter);
  const rows = sort ? sortRows(filtered, sort.col, sort.dir) : filtered;
  const sortBy = (j) => setSort((s0) => (!s0 || s0.col !== j ? { col: j, dir: 1 } : s0.dir === 1 ? { col: j, dir: -1 } : null));
  return (
    <div className="table-contents stack-tight">
      <div className="row wrap">
        <span className="muted small grow">{shown.length.toLocaleString()} row{shown.length === 1 ? '' : 's'} · {cols} column{cols === 1 ? '' : 's'}{more ? ` · only the first ${shown.length.toLocaleString()} are shown: download it or open it as a spreadsheet for the rest` : ''}</span>
        {toggle}
      </div>
      <div className="row wrap">
        <input type="search" className="grow" placeholder="Filter rows" aria-label="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {filter && <span className="muted small" aria-live="polite">{rows.length.toLocaleString()} of {shown.length.toLocaleString()} rows</span>}
      </div>
      <div className="table-view" tabIndex={0} role="region" aria-label={`Table of ${name}`}>
        <table>
          <thead><tr><th scope="col" className="table-num"><span className="sr-only">Row</span></th>{Array.from({ length: cols }, (_, j) => {
            const on = sort?.col === j ? sort.dir : 0;
            return (
              <th key={j} scope="col" aria-sort={on === 1 ? 'ascending' : on === -1 ? 'descending' : 'none'}>
                <button type="button" className="table-sort" title="Sort by this column" onClick={() => sortBy(j)}>{head[j] ?? ''}<span aria-hidden="true" className="table-sort-mark">{on === 1 ? ' ▲' : on === -1 ? ' ▼' : ''}</span></button>
              </th>
            );
          })}</tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.n}><th scope="row" className="table-num">{r.n}</th>{Array.from({ length: cols }, (_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}
            {!rows.length && <tr><td colSpan={cols + 1} className="muted">No rows contain “{filter}”</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
