// An email saved as a file (an attachment forwarded "as attachment", or an .eml in Drive or Chat), shown
// as a message: from, to, when, subject, its text and what's attached. `url` gives what the server read.
import { useEffect, useState } from 'react';
import { get, formatBytes } from '../api.js';
import Icon from '../components/Icon.jsx';

const who = (p) => (p ? (p.name ? `${p.name} <${p.address}>` : p.address) : '');

export default function EmlContents({ url }) {
  const [m, setM] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setM(null); setError('');
    get(url).then((d) => live && setM(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [url]);
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!m) return <p className="muted">Opening the email…</p>;
  return (
    <article className="eml-contents" aria-label={`Email: ${m.subject || '(no subject)'}`}>
      <h3 className="eml-subject">{m.subject || '(no subject)'}</h3>
      <dl className="eml-head">
        <dt>From</dt><dd>{who(m.from) || '—'}</dd>
        {m.to.length > 0 && <><dt>To</dt><dd>{m.to.map(who).join(', ')}</dd></>}
        {m.cc.length > 0 && <><dt>Cc</dt><dd>{m.cc.map(who).join(', ')}</dd></>}
        {m.date && <><dt>Date</dt><dd>{new Date(m.date).toLocaleString()}</dd></>}
      </dl>
      <div className="eml-text">{m.text || <span className="muted">(no text)</span>}</div>
      {m.attachments.length > 0 && (
        <ul className="eml-attachments" aria-label="Attached to this email">
          {m.attachments.map((a, i) => <li key={i}><Icon name="attach" size={16} /> <span className="grow ellipsis">{a.filename}</span> <span className="muted small">{formatBytes(a.size)}</span></li>)}
        </ul>
      )}
      <p className="muted small">Shown as text. Download it to open it with its formatting and attachments in a mail program.</p>
    </article>
  );
}
