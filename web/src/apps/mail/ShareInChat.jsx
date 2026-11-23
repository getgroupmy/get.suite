import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import ConversationPick, { conversationName, latestFirst } from '../../components/ConversationPick.jsx';

/** Share in Chat: a card of this email (who, subject, the start of its text) in a conversation, with a note.
 *  uids: several at once (the ticked ones), each its own card. */
export default function ShareInChat({ uid, uids, folder, subject, onClose }) {
  const many = uids?.length > 1;
  const toast = useToast();
  const navigate = useNavigate();
  const [convs, setConvs] = useState(null);
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    get('/chat/channels').then((d) => {
      const open = latestFirst(d.channels || []); // the latest conversation first, chosen
      setConvs(open);
      setTo(open[0]?.id || '');
    }).catch((e) => setError(e.message));
  }, []);
  const name = conversationName;
  async function submit(e) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      if (uids) await post('/mail/messages/chat', { folder, uids, channel_id: to, body: note.trim() });
      else await post(`/mail/messages/${uid}/chat`, { folder, channel_id: to, body: note.trim() });
      const where = convs.find((c) => c.id === to);
      toast(`${many ? `${uids.length} emails shared` : 'Shared'} in ${where ? name(where) : 'Chat'}`, 'info', { action: { label: 'Open', onClick: () => navigate(`/chat/${to}`) } });
      onClose();
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title={many ? `Share ${uids.length} emails in Chat` : 'Share in Chat'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>{many ? <>Each email goes as its own card (your message with the first): who it's from, its subject and the start of what it says, with the names of any attachments. The emails themselves stay in your mailbox.</>
          : <>Everyone there sees who it's from, <strong>{subject || '(no subject)'}</strong>, and the start of what it says, with the names of any attachments. The email itself stays in your mailbox.</>}</p>
        <ConversationPick conversations={convs} value={to} onChange={setTo} ariaLabel="Conversation" disabled={!convs} />
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
