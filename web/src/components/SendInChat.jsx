import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, put } from '../api.js';
import { Modal } from './ui.jsx';

/**
 * Send in Chat: links (items: [{ name, url }]) go into the chosen conversation's message box (its draft, after anything
 * already typed there), and the conversation opens to add a word and send. Chat shows them as cards, and offers to share
 * a Drive file with anyone there who can't open it.
 */
export default function SendInChat({ items, what = 'them', onClose }) {
  const navigate = useNavigate();
  const [convs, setConvs] = useState(null);
  const [to, setTo] = useState('');
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
    e.stopPropagation(); // opened from inside another form (an event's window): don't submit that one too
    try {
      const drafts = await get('/chat/drafts').catch(() => ({}));
      const before = drafts[to]?.body?.trim();
      const links = items.map((x) => `${x.name}: ${x.url}`).join('\n');
      await put(`/chat/channels/${to}/draft`, { body: before ? `${before}\n${links}` : links, client: 'send-in-chat' });
      onClose();
      navigate(`/chat/${to}`);
    } catch (err) { setError(err.message); }
  }
  return (
    <Modal title={`Send ${what} in Chat`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>Links go in the conversation's message box, to add a word and send.</p>
        <label className="field"><span>To</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} required disabled={!convs} aria-label="Conversation">
            {(convs || []).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
          </select>
        </label>
        {convs && !convs.length && <p className="muted small">You're not in any conversations yet.</p>}
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!to}>Open in Chat</button></div>
      </form>
    </Modal>
  );
}
