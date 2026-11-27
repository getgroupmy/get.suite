// An earlier version of a text, code or data file compared with the file now, line by line: removed lines (−, with
// their old line number), added ones (+, with their new one), and long unchanged stretches folded to a few lines
// around each change (Show … unchanged lines opens one).
import { useEffect, useState } from 'react';
import { get } from '../../api.js';
import { foldLines } from './versionfold.js';

export default function VersionDiff({ fileId, version, when, onBack }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(() => new Set());
  useEffect(() => {
    let live = true;
    get(`/files/${fileId}/versions/${version.id}/diff`).then((x) => live && setD(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [fileId, version.id]);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!d) return <p className="muted">Comparing…</p>;
  const same = !d.added && !d.removed;
  return (
    <div className="stack-tight version-diff">
      <div className="row wrap">
        <button type="button" className="btn small" onClick={onBack}>← All versions</button>
        <span className="muted small grow">{when(version.saved_at)} compared with now: <span className="diff-count-add">{d.added} line{d.added === 1 ? '' : 's'} added</span>, <span className="diff-count-del">{d.removed} removed</span>{d.rough ? ' (too different to match line by line: shown as replaced)' : ''}</span>
      </div>
      {same ? <p className="muted">No differences: this version has the same text as the file now.</p> : (
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
      )}
    </div>
  );
}
