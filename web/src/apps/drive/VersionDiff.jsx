// An earlier version of a text, code or data file compared with the file now, line by line: removed lines (−, with
// their old line number), added ones (+, with their new one), and long unchanged stretches folded to a few lines
// around each change (Show … unchanged lines opens one).
import { useEffect, useState } from 'react';
import { get } from '../../api.js';
import { foldLines } from './versionfold.js';

export default function VersionDiff({ fileId, version, versions = [], when, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [withId, setWithId] = useState(''); // '' : the file now; or another earlier version
  useEffect(() => {
    let live = true;
    setD(null); setError('');
    get(`/files/${fileId}/versions/${version.id}/diff${withId ? `?with=${encodeURIComponent(withId)}` : ''}`).then((x) => live && setD(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [fileId, version.id, withId]);
  const others = versions.filter((x) => x.id !== version.id);
  const picker = others.length > 0 && (
    <label className="row small">Compare with
      <select value={withId} onChange={(e) => setWithId(e.target.value)}>
        <option value="">the file now</option>
        {others.map((x) => <option key={x.id} value={x.id}>{x.label ? `${x.label} · ` : ''}{when(x.saved_at)}</option>)}
      </select>
    </label>
  );
  if (error) return <div className="stack-tight">{picker}<p className="error" role="alert">{error}</p></div>;
  if (!d) return <p className="muted">Comparing…</p>;
  const from = d.version, to = d.with; // older → newer (to: null for the file now)
  return (
    <div className="stack-tight version-diff">
      <div className="row wrap">
        <button type="button" className="btn small" onClick={onBack}>← All versions</button>
        {picker}
        <span className="muted small grow">{when(from.saved_at)} compared with {to ? when(to.saved_at) : 'now'}: <span className="diff-count-add">{d.added} line{d.added === 1 ? '' : 's'} added</span>, <span className="diff-count-del">{d.removed} removed</span>{d.rough ? ' (too different to match line by line: shown as replaced)' : ''}</span>
      </div>
      <DiffBody d={d} />
    </div>
  );
}

/** The lines of a comparison: removed and added with their line numbers, long unchanged runs folded. */
export function DiffBody({ d }) {
  const [open, setOpen] = useState(() => new Set());
  if (!d.added && !d.removed) return <p className="muted">No differences: these have the same text.</p>;
  return (
        <div className="diff-view" tabIndex={0} role="region" aria-label="Differences, line by line">
          {foldLines(d.lines, open).map((l, k) => (l.fold
            ? <button key={`f${l.fold[0]}`} type="button" className="diff-fold" onClick={() => setOpen(new Set([...open, l.fold[0]]))}>Show {l.fold[1] - l.fold[0]} unchanged lines</button>
            : (
              <div key={k} className={`diff-line ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}`}>
                <span className="diff-num" aria-hidden="true">{l.a ?? ''}</span><span className="diff-num" aria-hidden="true">{l.b ?? ''}</span>
                <span className="diff-op" aria-hidden="true">{l.op === '=' ? ' ' : l.op === '+' ? '+' : '−'}</span>
                <span className="diff-text">{l.op === '+' ? <span className="sr-only">Added: </span> : l.op === '-' ? <span className="sr-only">Removed: </span> : null}{l.text || ' '}</span>
              </div>
            )))}
        </div>
  );
}
