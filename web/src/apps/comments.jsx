// The comments panel shared by Docs and Sheets: threads (each anchored to text or a cell), replies,
// resolving, deleting, and a comment box where typing "@" suggests colleagues to mention.
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, patch, del, onLive, formatDate } from '../api.js';
import { Avatar, useToast } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { useMentions, MentionedAway } from '../components/mentions.jsx';
import { useAuth } from '../App.jsx';
import { forYou, commentLink, newSince } from './commentsFilter.js';

/**
 * Comments of a file, kept up to date live. `fresh`: the open threads with something from someone else since
 * you last looked (`seenAt`; never looked: all of theirs); `markSeen()` says you've looked now.
 */
export function useComments(fileId) {
  const { user } = useAuth();
  const [list, setList] = useState([]);
  const [seenAt, setSeenAt] = useState(undefined); // undefined while loading, null if never looked
  const load = useCallback(() => { if (fileId) get(`/comments/${fileId}`).then(setList).catch(() => {}); }, [fileId]);
  useEffect(load, [load]);
  useEffect(() => { if (fileId) get(`/comments/${fileId}/seen`).then((r) => setSeenAt(r.seen_at)).catch(() => setSeenAt(null)); }, [fileId]);
  useEffect(() => onLive((m) => { if (m.type === 'live-connected' || (m.type === 'comments-changed' && m.id === fileId)) load(); }), [fileId, load]);
  const threads = list.filter((c) => !c.thread_id).map((root) => ({ ...root, replies: list.filter((c) => c.thread_id === root.id) }));
  const markSeen = useCallback(() => { if (fileId) post(`/comments/${fileId}/seen`).then((r) => setSeenAt(r.seen_at)).catch(() => {}); }, [fileId]);
  const fresh = seenAt === undefined ? [] : newSince(threads, seenAt, user?.id).filter((t) => !t.resolved);
  return { threads, reload: load, fresh, seenAt, markSeen };
}

/** "2 new" on a Comments button. */
export const NewCount = ({ n }) => (n ? <span className="comments-new-count">{n} new</span> : null);



/** A text box for a comment; "@" plus a few letters suggests people to mention. */
function MentionBox({ value, onChange, onSubmit, placeholder, autoFocus, label }) {
  const ref = useRef();
  const { user } = useAuth();
  const mention = useMentions(ref, value, onChange);
  return (
    <div className="mention-box">
      <textarea ref={ref} rows={2} value={value} placeholder={placeholder} aria-label={label} autoFocus={autoFocus}
        onChange={(e) => { onChange(e.target.value); mention.track(e.target.value, e.target.selectionStart); }}
        onKeyDown={(e) => {
          if (mention.keyDown(e)) return;
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit(); }
        }} />
      {mention.list}
      <MentionedAway text={value} skip={[user?.id]} className="small muted mention-away" />
    </div>
  );
}

const QUICK = ['👍', '❤️', '🎉', '👀', '✅', '😂'];
/** Reactions under a comment: click one to add yours or take it back; ☺ offers a few. */
function Reactions({ fileId, c, canReact }) {
  const { user } = useAuth();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const react = async (emoji) => { setPicking(false); try { await post(`/comments/${fileId}/${c.id}/reactions`, { emoji }); } catch (e) { toast(e.message, 'error'); } };
  const list = c.reactions || [];
  if (!list.length && !canReact) return null;
  return (
    <div className="comment-reactions" onClick={(e) => e.stopPropagation()}>
      {list.map((r) => {
        const mine = r.users.some((u) => u.id === user?.id);
        return <button key={r.emoji} type="button" className={`reaction ${mine ? 'mine' : ''}`} aria-pressed={mine} disabled={!canReact}
          aria-label={`${r.emoji} ${r.users.length}: ${r.users.map((u) => u.name).join(', ')}`} title={r.users.map((u) => u.name).join(', ')} onClick={() => react(r.emoji)}>{r.emoji} {r.users.length}</button>;
      })}
      {canReact && (picking
        ? <span className="reaction-quick" role="group" aria-label="Pick a reaction">{QUICK.map((e) => <button key={e} type="button" className="icon-btn" aria-label={`React with ${e}`} onClick={() => react(e)}>{e}</button>)}</span>
        : <button type="button" className="icon-btn reaction-add" aria-label="Add a reaction" title="Add a reaction" onClick={() => setPicking(true)}>☺</button>)}
    </div>
  );
}

const Body = ({ text }) => <p className="comment-body">{text.split(/(@[\w.+-]+@[\w.-]+\.[a-z]{2,})/gi).map((part, i) => (part.startsWith('@') ? <span key={i} className="mention">{part}</span> : part))}</p>;

/**
 * The panel. `pending` is a new comment being started ({ anchor, label, onCreated(id), onCancel }).
 * `onShow(thread)` jumps to where a thread is anchored; `labelOf(thread)` says where that is.
 */
export function CommentsPanel({ fileId, fileRole, threads, seenAt, onSeen, canEdit, active, setActive, pending, onShow, labelOf, onDeleted, onClose }) {
  const toast = useToast();
  const { user } = useAuth();
  const [editing, setEditing] = useState(null); // { id, text }: your own comment being changed
  const saveEdit = async () => {
    if (!editing?.text.trim()) return;
    try {
      const r = await patch(`/comments/${fileId}/${editing.id}`, { body: editing.text });
      setEditing(null);
      if (r.noAccess?.length) toast(`${r.noAccess.join(', ')} can't open this file, so they weren't told. Share it with them first.`, 'error');
      else if (r.notified?.length) toast(`${r.notified.join(', ')} ${r.notified.length === 1 ? 'was' : 'were'} told by chat`);
    } catch (e) { toast(e.message, 'error'); }
  };
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState('');
  const [replies, setReplies] = useState({});
  // "Assign to": the people @mentioned in a new comment (from the company directory).
  const [people, setPeople] = useState([]);
  const [assignTo, setAssignTo] = useState('');
  useEffect(() => { if (pending) get('/users/directory').then(setPeople).catch(() => {}); }, [!!pending]); // eslint-disable-line react-hooks/exhaustive-deps
  const mentioned = [...new Set([...draft.matchAll(/@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))]
    .map((e) => people.find((p) => p.username === e)).filter(Boolean);
  const send = async (body, extra) => {
    const r = await post(`/comments/${fileId}`, { body, ...extra });
    if (r.noAccess?.length) toast(`${r.noAccess.join(', ')} can't open this file, so they weren't told. Share it with them first.`, 'error');
    else if (r.notified?.length) toast(`${r.notified.join(', ')} ${r.notified.length === 1 ? 'was' : 'were'} told by chat`);
    return r.comment;
  };
  const [onlyMine, setOnlyMine] = useState(false);
  // What's new is what came after you last looked before opening the panel; it stays marked while it's open,
  // and having it open counts as looking (again whenever more comes in).
  const [since, setSince] = useState(seenAt);
  useEffect(() => { if (since === undefined && seenAt !== undefined) setSince(seenAt); }, [seenAt, since]);
  const isNew = new Set(since === undefined ? [] : newSince(threads, since, user?.id).map((t) => t.id));
  const latest = threads.reduce((m, t) => Math.max(m, ...[t, ...t.replies].map((c) => c.edited_at || c.created_at)), 0);
  useEffect(() => { if (since !== undefined) onSeen?.(); }, [since !== undefined, latest]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = forYou(threads, user);
  const shown = (onlyMine ? mine : threads).filter((t) => showResolved || !t.resolved || t.id === active);
  const copyLink = async (t) => {
    try { await navigator.clipboard.writeText(commentLink(location.origin, location.pathname, fileId, t.id)); toast('Link to the comment copied: paste it in Chat or an email'); } catch { toast('Couldn’t copy the link', 'error'); }
  };

  return (
    <aside className="comments-panel" aria-label="Comments">
      <div className="row comments-head">
        <h2 className="grow">Comments</h2>
        <button type="button" className="icon-btn" aria-label="Close comments" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      <div className="row comments-filters">
        <label className="check small" title="Comments that @mention you or are assigned to you"><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> For you{mine.length ? ` (${mine.filter((t) => !t.resolved).length})` : ''}</label>
        <label className="check small"><input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved</label>
      </div>
      {pending && (
        <form className="comment-new stack" onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          const who = mentioned.find((p) => p.id === assignTo);
          try { const c = await send(draft, { anchor: pending.anchor, id: pending.id, ...(who && { assign: who.id }) }); setDraft(''); setAssignTo(''); pending.onCreated(c.id); setActive(c.id); if (who) toast(`Assigned to ${who.name}: it's on their task list`); } catch (err) { toast(err.message, 'error'); }
        }}>
          <span className="muted small">On {pending.label}</span>
          <MentionBox value={draft} onChange={setDraft} autoFocus label="New comment" placeholder="Comment, or @mention someone" onSubmit={() => document.querySelector('.comment-new button[type=submit]')?.click()} />
          {mentioned.length > 0 && (
            <label className="row small comment-assign">Assign to
              <select aria-label="Assign to" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                <option value="">Nobody</option>
                {mentioned.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></label>
          )}
          <div className="row end">
            <button type="button" className="btn small" onClick={() => { setDraft(''); setAssignTo(''); pending.onCancel(); }}>Cancel</button>
            <button type="submit" className="btn small primary" disabled={!draft.trim()}>Comment</button>
          </div>
        </form>
      )}
      {!pending && shown.length === 0 && <p className="muted small">{onlyMine ? 'Nothing for you here: no open comment @mentions you or is assigned to you.' : threads.length ? 'No open comments.' : canEdit ? 'Select something and press Comment to start a conversation.' : 'No comments yet.'}</p>}
      <ol className="comment-threads">
        {shown.map((t) => (
          <li key={t.id} className={`comment-thread ${t.id === active ? 'active' : ''} ${t.resolved ? 'resolved' : ''} ${isNew.has(t.id) ? 'new' : ''}`} onClick={() => { setActive(t.id); onShow(t); }}>
            <div className="row comment-top">
              {isNew.has(t.id) && <span className="comment-new-tag">New</span>}
              <button type="button" className="link-btn small comment-where grow" onClick={(e) => { e.stopPropagation(); setActive(t.id); onShow(t); }}>{labelOf(t)}</button>
              <button type="button" className="icon-btn" aria-label="Copy link to comment" title="Copy link to comment" onClick={(e) => { e.stopPropagation(); copyLink(t); }}><Icon name="link" size={16} /></button>
            </div>
            {[t, ...t.replies].map((c) => (
              <div key={c.id} className="comment">
                <div className="row comment-meta"><Avatar name={c.author_name || '?'} size={24} /><strong className="grow">{c.author_name || 'Someone'}</strong><span className="muted small">{formatDate(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
                  {canEdit && c.author_id === user?.id && editing?.id !== c.id && <button type="button" className="icon-btn" aria-label={`Edit comment by ${c.author_name}`} title="Edit" onClick={(e) => { e.stopPropagation(); setActive(t.id); setEditing({ id: c.id, text: c.body }); }}><Icon name="edit" size={16} /></button>}
                  {canEdit && (c.author_id === user?.id || fileRole === 'owner') && <button type="button" className="icon-btn" aria-label={`Delete comment by ${c.author_name}`} onClick={async (e) => { e.stopPropagation(); try { await del(`/comments/${fileId}/${c.id}`); if (c.id === t.id) onDeleted?.(t); } catch (err) { toast(err.message, 'error'); } }}><Icon name="trash" size={16} /></button>}</div>
                {editing?.id === c.id
                  ? <div className="stack comment-edit" onClick={(e) => e.stopPropagation()}>
                    <MentionBox value={editing.text} onChange={(v) => setEditing({ ...editing, text: v })} label="Edit comment" autoFocus onSubmit={saveEdit} />
                    <div className="row end">
                      <button type="button" className="btn small" onClick={() => setEditing(null)}>Cancel</button>
                      <button type="button" className="btn small primary" disabled={!editing.text.trim() || editing.text === c.body} onClick={saveEdit}>Save</button>
                    </div>
                  </div>
                  : <Body text={c.body} />}
                <Reactions fileId={fileId} c={c} canReact={canEdit} />
              </div>
            ))}
            {t.assignee_name && <p className={`small comment-assigned ${t.resolved ? 'muted' : ''}`}>☑ Assigned to {t.assignee_name}{t.resolved ? ' · done' : ''}</p>}
            {t.resolved && <p className="muted small">Resolved by {t.resolved_by_name || 'someone'}</p>}
            {canEdit && t.id === active && (
              <div className="stack comment-reply" onClick={(e) => e.stopPropagation()}>
                <MentionBox value={replies[t.id] || ''} onChange={(v) => setReplies({ ...replies, [t.id]: v })} label="Reply" placeholder="Reply"
                  onSubmit={async () => { if ((replies[t.id] || '').trim()) { await send(replies[t.id], { thread_id: t.id }); setReplies({ ...replies, [t.id]: '' }); } }} />
                <div className="row end">
                  <button type="button" className="btn small" onClick={() => patch(`/comments/${fileId}/${t.id}`, { resolved: !t.resolved })}>{t.resolved ? 'Reopen' : 'Resolve'}</button>
                  <button type="button" className="btn small primary" disabled={!(replies[t.id] || '').trim()}
                    onClick={async () => { await send(replies[t.id], { thread_id: t.id }); setReplies({ ...replies, [t.id]: '' }); }}>Reply</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
