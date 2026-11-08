// What's inside a zip file (Drive previews, email attachments): its folders and files, indented,
// with sizes. `url` gives { entries: [{ path, size, dir }], files, folders, size, more }.
import { useEffect, useState } from 'react';
import { get, formatBytes } from '../api.js';
import Icon from '../components/Icon.jsx';

export default function ZipContents({ url }) {
  const [z, setZ] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setZ(null); setError('');
    get(url).then((d) => live && setZ(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [url]);
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!z) return <p className="muted">Looking inside…</p>;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <div className="zip-contents">
      <p className="muted small" style={{ margin: '0 0 8px' }}>{plural(z.files, 'file')}{z.folders ? ` in ${plural(z.folders, 'folder')}` : ''} · {formatBytes(z.size)} unpacked</p>
      {z.entries.length ? (
        <ul className="zip-list" aria-label="Inside the zip">
          {z.entries.map((e) => {
            const depth = e.path.split('/').length - 1;
            const name = e.path.split('/').pop();
            return (
              <li key={e.path} style={{ paddingLeft: 8 + depth * 18 }} className={e.dir ? 'dir' : ''}>
                <Icon name={e.dir ? 'folder' : 'file'} size={16} /><span className="grow ellipsis">{name}</span>{!e.dir && <span className="muted small">{formatBytes(e.size)}</span>}
              </li>
            );
          })}
        </ul>
      ) : <p className="muted">This zip is empty.</p>}
      {z.more > 0 && <p className="muted small">…and {z.more} more</p>}
    </div>
  );
}
