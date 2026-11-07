// Opening a link to a file you can't open: ask its owner for access (view or edit, with a note).
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { post } from '../api.js';
import Icon from '../components/Icon.jsx';

export default function RequestAccess() {
  const { id } = useParams();
  const [role, setRole] = useState('viewer');
  const [message, setMessage] = useState('');
  const [state, setState] = useState(null); // null | 'sending' | 'sent' | error text
  const send = async (e) => {
    e.preventDefault();
    setState('sending');
    try { await post(`/files/${encodeURIComponent(id)}/request-access`, { role, message }); setState('sent'); } catch (err) { setState(err.message); }
  };
  return (
    <div className="page access-page">
      <div className="access-card">
        <Icon name="lock" size={40} />
        <h1>You need access</h1>
        {state === 'sent' ? (
          <>
            <p>Your request was sent. You'll get a notification when it's answered, and the file will then be in <strong>Shared with me</strong>.</p>
            <Link className="btn" to="/drive">Back to Drive</Link>
          </>
        ) : (
          <form className="stack" onSubmit={send}>
            <p className="muted" style={{ margin: 0 }}>This file hasn't been shared with you, or it's no longer there. Ask its owner for access.</p>
            <label className="field"><span>I'd like to</span>
              <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Access to ask for"><option value="viewer">View it</option><option value="editor">Edit it</option></select></label>
            <label className="field"><span>Message (optional)</span><textarea rows={3} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Why you need it" /></label>
            {state && state !== 'sending' && <p className="error">{state}</p>}
            <div className="row end"><Link className="btn" to="/drive">Back to Drive</Link><button className="btn primary" disabled={state === 'sending'}>Request access</button></div>
          </form>
        )}
      </div>
    </div>
  );
}
