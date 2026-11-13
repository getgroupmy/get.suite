import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';

/** Share in Chat: a card of this email (who, subject, the start of its text) in a conversation, with a note. */
export default function ShareInChat({ uid, folder, subject, onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [convs, setConvs] = useState(null);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    get('/chat/channels').then((d) => {
      const open = (d.channels || []).filter((c) => !c.archived_at);
      setConvs(open);
      setTo(open[0]?.id || '');
    }).catch((e) => setError(e.message));
  }, []);
  const name = (c) => (c.dm_key ? `${c.dm_name || 'Notes to self'}${c.dm_org ? ` (${c.dm_org})` : ''}` : `# ${c.name}`);
  async function submit(e) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      await post(`/mail/messages/${uid}/chat`, { folder, channel_id: to, body: note.trim() });
      const where = convs.find((c) => c.id === to);
      toast(`Shared in ${where ? name(where) : 'Chat'}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/chat/${to}`) } });
      onClose();
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title="Share in Chat" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>Everyone there sees who it's from, <strong>{subject || '(no subject)'}</strong>, and the start of what it says, with the names of any attachments. The email itself stays in your mailbox.</p>
        <label className="field"><span>To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} required disabled={!convs} aria-label="Conversation">
            {(convs || []).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
          </select>
        </label>
        <label className="field"><span>Message (optional)</span>
          <textarea rows={2} value={note} maxLength={8000} onChange={(e) => setNote(e.target.value)} placeholder="Can someone pick this up?" />
        </label>
        {convs && !convs.length && <p className="muted small">You're not in any conversations yet.</p>}
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!to || busy}>Share</button></div>
      </form>
    </Modal>
  );
}
