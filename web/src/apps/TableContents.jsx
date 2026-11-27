// A CSV or TSV file shown as a table: its first row as the headings (kept in view while scrolling), the first
// 1,000 rows; Show as text gives the file as written. `load` gives { text, truncated } as for the code viewer.
import { useEffect, useMemo, useState } from 'react';
import { separatorFor, parseTable } from './csvtable.js';
import CodeContents from './CodeContents.jsx';

const MAX_ROWS = 1000;

export default function TableContents({ name, load }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [asText, setAsText] = useState(false);
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
  return (
    <div className="table-contents stack-tight">
      <div className="row wrap">
        <span className="muted small grow">{shown.length.toLocaleString()} row{shown.length === 1 ? '' : 's'} · {cols} column{cols === 1 ? '' : 's'}{more ? ` · only the first ${shown.length.toLocaleString()} are shown: download it or open it as a spreadsheet for the rest` : ''}</span>
        {toggle}
      </div>
      <div className="table-view" tabIndex={0} role="region" aria-label={`Table of ${name}`}>
        <table>
          <thead><tr><th scope="col" className="table-num"><span className="sr-only">Row</span></th>{Array.from({ length: cols }, (_, j) => <th key={j} scope="col">{head[j] ?? ''}</th>)}</tr></thead>
          <tbody>
            {shown.map((r, i) => <tr key={i}><th scope="row" className="table-num">{i + 2}</th>{Array.from({ length: cols }, (_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
