// A code or data file (.json, .xml, .yaml, .py, .sql…) shown as its text, with line numbers; JSON written on one line
// is laid out to be read. `load` gives { text, truncated } (the first 512 KB). Shown as text: nothing in it runs.
import { useEffect, useState } from 'react';

export const TEXT_MAX = 512 * 1024;
/** Read a file's text from an address (an attachment, a chat file), the first 512 KB of it. */
export async function textFrom(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('The file couldn’t be read');
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.slice(0, TEXT_MAX).includes(0)) throw new Error('This file isn’t text');
  return { text: new TextDecoder().decode(buf.slice(0, TEXT_MAX)).replace(/�$/, ''), truncated: buf.length > TEXT_MAX };
}

/** One-line JSON laid out with indents; anything else as it is. */
export function readable(name, text) {
  if (!/\.json$/i.test(name) || text.includes('\n') || text.length > 200000) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export default function CodeContents({ name, load }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [laid, setLaid] = useState(true);
  useEffect(() => {
    let live = true;
    setD(null); setError('');
    load().then((x) => live && setD(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!d) return <p className="muted">Reading the file…</p>;
  const pretty = readable(name, d.text);
  const text = laid ? pretty : d.text;
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return (
    <div className="code-contents stack-tight">
      <div className="row wrap">
        <span className="muted small grow">{lines.length.toLocaleString()} line{lines.length === 1 ? '' : 's'}{d.truncated ? ' · only the start is shown: download it for the rest' : ''}</span>
        {pretty !== d.text && <button type="button" className="btn small" aria-pressed={laid} onClick={() => setLaid(!laid)}>{laid ? 'Show as written' : 'Lay out'}</button>}
      </div>
      <pre className="code-view" tabIndex={0} aria-label={`Text of ${name}`}>
        {lines.map((l, i) => <span key={i} className="code-line"><span className="code-num" aria-hidden="true">{i + 1}</span>{l}{'\n'}</span>)}
      </pre>
    </div>
  );
}
