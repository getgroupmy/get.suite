// Bookmarks bar: links at the top of a conversation (the plan document, a sheet, a website), for everyone in it.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, del, onLive } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Modal, useToast } from '../../components/ui.jsx';

export default function Bookmarks({ channel }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ title: '', url: '' });
  const load = useCallback(() => get(`/chat/channels/${channel.id}/bookmarks`).then(setList).catch(() => setList([])), [channel.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onLive((m) => { if (m.type === 'live-connected' || (m.type === 'bookmarks-changed' && m.channel_id === channel.id)) load(); }), [channel.id, load]);
  const can = !channel.archived_at && !channel.left;
  const add = async (e) => {
    e.preventDefault();
    // A link to a page of this Workspace is kept as that page, so it opens here.
    const url = f.url.trim().startsWith(window.location.origin + '/') ? f.url.trim().slice(window.location.origin.length) : f.url;
    try { setList(await post(`/chat/channels/${channel.id}/bookmarks`, { ...f, url })); setAdding(false); setF({ title: '', url: '' }); toast('Bookmark added for everyone in the conversation'); }
    catch (err) { toast(err.message, 'error'); }
  };
  const remove = async (b) => { try { setList(await del(`/chat/channels/${channel.id}/bookmarks/${b.id}`)); toast(`“${b.title}” removed`); } catch (e) { toast(e.message, 'error'); } };
  // A page in Workspace opens here; a web address in a new tab.
  const open = (e, b) => { if (b.url.startsWith('/')) { e.preventDefault(); navigate(b.url); } };
  if (!list.length && !can) return null;
  return (
    <div className="chat-bookmarks" role="navigation" aria-label="Bookmarks">
      {list.map((b) => (
        <span key={b.id} className="chat-bookmark">
          <a href={b.url} {...(b.url.startsWith('/') ? {} : { target: '_blank', rel: 'noreferrer noopener' })} onClick={(e) => open(e, b)} title={`${b.url} · added by ${b.added_by || 'someone'}`}>
            <Icon name="link" size={14} /> {b.title}
          </a>
          {can && <button type="button" className="chat-bookmark-x" aria-label={`Remove bookmark ${b.title}`} title="Remove" onClick={() => remove(b)}>×</button>}
        </span>
      ))}
      {can && <button type="button" className="link-btn small" onClick={() => setAdding(true)}>+ Bookmark</button>}
      {adding && (
        <Modal title="Add a bookmark" onClose={() => setAdding(false)} footer={<>
          <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
          <button type="submit" form="bm-form" className="btn primary">Add</button>
        </>}>
          <form id="bm-form" className="stack" onSubmit={add}>
            <label className="field"><span>Link</span><input autoFocus required value={f.url} placeholder="https://… or a Workspace address (paste a document's link)" onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
            <label className="field"><span>Name (optional)</span><input value={f.title} maxLength={80} placeholder="Q3 plan" onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
            <p className="muted small" style={{ margin: 0 }}>Everyone in this conversation sees it at the top, and can open or remove it.</p>
          </form>
        </Modal>
      )}
    </div>
  );
}
