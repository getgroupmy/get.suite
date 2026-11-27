// Two text, code or data files compared line by line (selected together in Drive): what's removed going from the
// first to the second, and what's added; Swap compares them the other way.
import { useEffect, useState } from 'react';
import { get } from '../../api.js';
import { Modal } from '../../components/ui.jsx';
import { DiffBody } from './VersionDiff.jsx';
import { previewKind } from '../../components/viewkind.js';
import { viewOnly } from './viewonly.js';

/** Whether a file can be compared this way: uploaded text, code or data this person may take away. */
export const comparableFile = (f) => f.kind === 'file' && !viewOnly(f) && (['code', 'table'].includes(previewKind(f.name)) || /\.(txt|md|markdown|log)$/i.test(f.name));

export default function FileCompare({ files, onClose }) {
  const [pair, setPair] = useState(files);
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setD(null); setError('');
    get(`/files/compare?a=${encodeURIComponent(pair[0].id)}&b=${encodeURIComponent(pair[1].id)}`).then((x) => live && setD(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [pair]);
  return (
    <Modal wide title={`Compare ${pair[0].name} and ${pair[1].name}`} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="stack-tight">
        <div className="row wrap">
          <span className="muted small grow">From <strong>{pair[0].name}</strong> to <strong>{pair[1].name}</strong>{d ? <>: <span className="diff-count-add">{d.added} line{d.added === 1 ? '' : 's'} added</span>, <span className="diff-count-del">{d.removed} removed</span>{d.rough ? ' (too different to match line by line: shown as replaced)' : ''}</> : ''}</span>
          <button type="button" className="btn small" onClick={() => setPair([pair[1], pair[0]])}>Swap</button>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : !d ? <p className="muted">Comparing…</p> : <DiffBody key={`${pair[0].id}-${pair[1].id}`} d={d} />}
      </div>
    </Modal>
  );
}
