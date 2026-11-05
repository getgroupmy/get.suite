import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { closeHistory } from '@tiptap/pm/history';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, get, post, put, del, onLive, uploadFile, formatBytes, formatDate } from '../../api.js';
import { desktopSupported, desktopOn, enableDesktop, disableDesktop } from '../../mailNotify.js';
import Icon from '../../components/Icon.jsx';
import EmojiPicker from '../../components/EmojiPicker.jsx';
import { Avatar, ConfirmModal, Empty, Menu, Modal, PromptModal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import { useEditor, EditorContent, Node as TiptapNode, Extension, mergeAttributes } from '@tiptap/react';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TextStyle, Color, BackgroundColor, FontSize, FontFamily } from '@tiptap/extension-text-style';
import { useMailStatus } from '../../mailStatus.js';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { textToHtml, docToText, emailHtml, isEmptyDoc, linkHref } from './richtext.js';
import { FiltersDialog } from './Filters.jsx';
import { ASPECTS, FULL, fitAspect, moveRect, resizeRect, toPixels, rotatedSize, outputType, editedName } from './cropmath.js';

const FOLDER_ICON = { '\\Inbox': 'inbox', '\\Drafts': 'doc', '\\Sent': 'send', '\\Archive': 'archive', '\\Junk': 'report', '\\Trash': 'trash' };
const enc = encodeURIComponent;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const who = (a) => (a ? a.name || a.address : '');
const list = (arr) => (arr || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');

export default function Mail() {
  const toast = useToast();
  const navigate = useNavigate();
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const folder = params.folder ? decodeURIComponent(params.folder) : 'INBOX';
  const openUid = params.uid ? Number(params.uid) : null;
  const q = search.get('q') || '';
  const page = Number(search.get('page') || 1);

  const [folders, setFolders] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [compose, setCompose] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [vacation, setVacation] = useState(null);
  const [vacationOpen, setVacationOpen] = useState(false);
  const [filters, setFilters] = useState(null); // null | { startWith?: rule }
  const [newFolder, setNewFolder] = useState(false);
  const [folderDialog, setFolderDialog] = useState(null);
  const [signatures, setSignatures] = useState([]);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const { user } = useAuth();
  useEffect(() => { get('/mail/signatures').then(setSignatures).catch(() => {}); }, []);

  /** Add the From address's signature to a new message, or above the quote in a reply/forward (never to resumed drafts). */
  const withSignature = (init, kind) => {
    const from = init.from || user.username;
    const block = signatureBlock(signatures, from, kind);
    const out = { ...init, from, kind };
    if (!block) return out;
    if (kind === 'new') return { ...out, html: `<p></p>${block}` };
    return { ...out, html: (init.html || '').replace(/^<p><\/p>/, `<p></p>${block}`) };
  };
  useEffect(() => { get('/mail/vacation').then(setVacation).catch(() => {}); }, []);

  const loadFolders = useCallback(() => get('/mail/folders').then(setFolders).catch((e) => setError(e.message)), []);
  const loadList = useCallback(() => get(`/mail/messages?folder=${enc(folder)}&page=${page}${q ? `&q=${enc(q)}` : ''}`)
    .then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)), [folder, page, q]);

  useEffect(() => { setData(null); setChecked(new Set()); loadList(); }, [loadList]);
  useEffect(() => { loadFolders(); }, [loadFolders]);
  // New mail arrives: refresh straight away instead of waiting for the next 30-second check.
  useEffect(() => onLive((m) => {
    if (m.type === 'mail-new' || m.type === 'mail-unread') { loadFolders(); if (m.type === 'mail-unread' || m.folder === folder) loadList(); }
  }), [loadFolders, loadList, folder]);
  // Folders with new-mail notifications (Inbox always). The badge counts unread mail across them.
  const [followed, setFollowed] = useState(['INBOX']);
  useEffect(() => { get('/mail/notify-folders').then((r) => setFollowed(r.folders)).catch(() => {}); }, []);
  useEffect(() => {
    if (!folders.length) return;
    const unseen = folders.filter((f) => followed.includes(f.path)).reduce((n, f) => n + (f.unseen || 0), 0);
    window.dispatchEvent(new CustomEvent('nw:unread', { detail: unseen }));
  }, [folders, followed]);
  async function toggleFollow(f) {
    const next = followed.includes(f.path) ? followed.filter((x) => x !== f.path) : [...followed, f.path];
    try {
      const r = await put('/mail/notify-folders', { folders: next });
      setFollowed(r.folders);
      toast(r.folders.includes(f.path) ? `You'll be notified about new mail in ${f.name}` : `No more notifications for ${f.name}`);
    } catch (e) { toast(e.message, 'error'); }
  }
  const [desktop, setDesktop] = useState(desktopOn());
  // Poll for new mail; retry quickly while the mailbox is unavailable (e.g. just created).
  const failing = !!error && !data;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) { loadFolders(); loadList(); } }, failing ? 4000 : 30000);
    return () => clearInterval(t);
  }, [loadFolders, loadList, failing]);

  const current = folders.find((f) => f.path === folder);
  const special = current?.specialUse;
  const refresh = () => { loadFolders(); loadList(); };
  const go = (f, uid) => navigate(`/mail/${enc(f)}${uid ? `/${uid}` : ''}${q ? `?q=${enc(q)}` : ''}`);

  async function act(path, body, msg) {
    try { await post(`/mail/messages/${path}`, { folder, ...body }); if (msg) toast(msg); setChecked(new Set()); refresh(); return true; }
    catch (e) { toast(e.message, 'error'); return false; }
  }

  if (failing) {
    return (
      <div className="page">
        <Empty icon="mail" title="Mail is unavailable">{error}</Empty>
        <div className="row" style={{ justifyContent: 'center' }}><button className="btn" onClick={() => { loadFolders(); loadList(); }}>Try again</button></div>
      </div>
    );
  }

  async function openDraft(uid) {
    try {
      const d = await get(`/mail/drafts/${uid}`);
      setCompose({ ...d, draftUid: d.uid, files: d.attachments });
    } catch (e) { toast(e.message, 'error'); }
  }

  const sel = [...checked];
  return (
    <div className={`mail ${openUid ? 'reading' : ''}`}>
      <aside className="subnav">
        <button className="btn new-btn" onClick={() => setCompose(withSignature({}, 'new'))}><Icon name="edit" /> Compose</button>
        {folders.map((f) => {
          const own = !f.specialUse && f.path.toUpperCase() !== 'INBOX';
          const followable = own || f.specialUse === '\\Archive'; // built-in Archive: notifications only, no rename/delete
          return (
            <div key={f.path} className="folder-row">
              <button className={`subnav-item ${f.path === folder && !q ? 'active' : ''}`} onClick={() => { setSearch({}); go(f.path); }}>
                <Icon name={FOLDER_ICON[f.specialUse] || 'folder'} /><span className="grow ellipsis">{f.name}</span>
                {followable && followed.includes(f.path) && <Icon name="bell" size={14} className="followed" title="New-mail notifications on" />}
                {f.unseen > 0 && f.specialUse !== '\\Trash' && f.specialUse !== '\\Sent' && <span className="count">{f.unseen}</span>}
                {f.specialUse === '\\Drafts' && f.messages > 0 && <span className="count muted">{f.messages}</span>}
              </button>
              {followable && (
                <Menu align="left" trigger={(p) => <button className="icon-btn folder-menu" aria-label={`Options for ${f.name}`} {...p}><Icon name="more" size={18} /></button>} items={[
                  { label: followed.includes(f.path) ? 'Stop notifications' : 'Notify me about new mail', icon: 'bell', onClick: () => toggleFollow(f) },
                  ...(own ? [
                    { label: 'Rename', icon: 'edit', onClick: () => setFolderDialog({ type: 'rename', folder: f }) },
                    { label: 'Delete', icon: 'trash', danger: true, onClick: () => setFolderDialog({ type: 'delete', folder: f }) },
                  ] : []),
                ]} />
              )}
            </div>
          );
        })}
        <button className="subnav-item new-folder" onClick={() => setNewFolder(true)}><Icon name="plus" /><span className="grow">New folder</span></button>
        <button className="subnav-item vacation-link" onClick={() => setVacationOpen(true)}>
          <Icon name="clock" /><span className="grow">Vacation reply</span>{vacation?.enabled && <span className="pill">{vacation.active ? 'On' : 'Scheduled'}</span>}
        </button>
        <button className="subnav-item" onClick={() => setFilters({})}><Icon name="settings" /><span className="grow">Filters</span></button>
        <button className="subnav-item" onClick={() => setSignatureOpen(true)}><Icon name="edit" /><span className="grow">Signature</span></button>
        {desktopSupported() && (
          <button className="subnav-item" aria-pressed={desktop} onClick={async () => {
            if (desktop) { disableDesktop(); setDesktop(false); toast('Desktop notifications off'); return; }
            const ok = await enableDesktop();
            setDesktop(ok);
            toast(ok ? 'Desktop notifications on: you’ll be alerted to new mail while Workspace is open in a background tab' : 'Notifications are blocked in your browser settings for this site', ok ? 'info' : 'error');
          }}><Icon name="mail" /><span className="grow">Desktop alerts</span><span className={`pill ${desktop ? '' : 'off'}`}>{desktop ? 'On' : 'Off'}</span></button>
        )}
      </aside>

      <section className="mail-list">
        <div className="mail-toolbar">
          <form className="mail-search" role="search" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('q').trim(); setSearch(v ? { q: v } : {}); }}>
            <Icon name="search" size={18} />
            <input name="q" defaultValue={q} key={q} placeholder={`Search ${current?.name || 'mail'}`} aria-label="Search mail" />
          </form>
          <button className="icon-btn" aria-label="Refresh" onClick={refresh}><Icon name="restore" size={20} /></button>
        </div>
        {vacation?.enabled && (vacation.active || vacation.scheduled) && (
          <div className="mail-vacation">
            <span>{vacation.active
              ? `Your vacation reply is on${vacation.end_date ? ` until ${fmtDay(vacation.end_date)}` : ''}.`
              : `Your vacation reply starts on ${fmtDay(vacation.start_date)}.`}</span>
            <button className="btn small" onClick={() => setVacationOpen(true)}>Edit</button>
            <button className="btn small" onClick={async () => {
              try { setVacation(await put('/mail/vacation', { ...vacation, enabled: false })); toast('Vacation reply turned off'); } catch (e) { toast(e.message, 'error'); }
            }}>Turn off</button>
          </div>
        )}
        {sel.length > 0 && (
          <div className="mail-bulk">
            <span>{sel.length} selected</span>
            <button className="btn small" onClick={() => act('flags', { uids: sel, seen: true })}>Mark read</button>
            <button className="btn small" onClick={() => act('flags', { uids: sel, seen: false })}>Mark unread</button>
            {special !== '\\Archive' && <button className="btn small" onClick={() => act('move', { uids: sel, to: 'archive' }, 'Archived')}>Archive</button>}
            <button className="btn small danger" onClick={() => act('delete', { uids: sel }, special === '\\Trash' ? 'Deleted forever' : 'Moved to Trash')}>Delete</button>
          </div>
        )}
        {q && <p className="muted small mail-note">Results for “{q}” in {current?.name} · <button className="link" onClick={() => setSearch({})}>clear</button></p>}
        {!data ? <p className="muted mail-note">Loading…</p> : data.messages.length === 0 ? (
          <Empty icon={q ? 'search' : 'inbox'} title={q ? 'No messages found' : `${current?.name || 'Folder'} is empty`} />
        ) : (
          <ul className="msg-list">
            {data.messages.map((m) => (
              <li key={m.uid} className={`${m.seen ? '' : 'unread'} ${m.uid === openUid ? 'open' : ''}`}>
                <input type="checkbox" aria-label={`Select ${m.subject || '(no subject)'}`} checked={checked.has(m.uid)}
                  onChange={(e) => { const n = new Set(checked); e.target.checked ? n.add(m.uid) : n.delete(m.uid); setChecked(n); }} />
                <button className="msg-row" onClick={() => (special === '\\Drafts' ? openDraft(m.uid) : go(folder, m.uid))}>
                  <span className="msg-from ellipsis">{special === '\\Sent' || special === '\\Drafts' ? `To: ${m.to.map(who).join(', ')}` : who(m.from)}</span>
                  <span className="msg-date">{m.flagged && <span className="star" aria-label="Starred">★</span>}{m.attachment && <Icon name="attach" size={14} />} {m.date ? formatDate(m.date) : ''}</span>
                  <span className="msg-subject ellipsis">{m.answered && '↩ '}{m.subject || '(no subject)'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data && data.total > (data.pageSize || 50) && (
          <div className="row mail-pager">
            <span className="muted small grow">{(page - 1) * 50 + 1}–{Math.min(page * 50, data.total)} of {data.total}</span>
            <button className="icon-btn" aria-label="Newer" disabled={page <= 1} onClick={() => setSearch({ ...(q && { q }), page: String(page - 1) })}><Icon name="left" /></button>
            <button className="icon-btn" aria-label="Older" disabled={page * 50 >= data.total} onClick={() => setSearch({ ...(q && { q }), page: String(page + 1) })}><Icon name="right" /></button>
          </div>
        )}
      </section>

      <section className="mail-reader">
        {openUid ? (
          <Reader key={`${folder}:${openUid}`} folder={folder} uid={openUid} special={special}
            onClose={() => go(folder)} onChanged={refresh} act={act} onCompose={(init) => setCompose(withSignature(init, 'reply'))}
            onFilter={(from) => setFilters({ startWith: { name: `From ${from}`, enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: from }], actions: { stop: true } } })} />
        ) : <Empty icon="mail" title="No message selected" />}
      </section>

      {compose && <Compose initial={compose} signatures={signatures} onClose={() => setCompose(null)} onSent={() => { setCompose(null); refresh(); }} onDraftsChanged={refresh} />}
      {filters && <FiltersDialog folders={folders} onFoldersChanged={loadFolders} startWith={filters.startWith} onClose={() => { setFilters(null); loadFolders(); }} />}
      {newFolder && <PromptModal title="New folder" label="Folder name (use / for subfolders, e.g. Clients/Acme)" confirm="Create" onClose={() => setNewFolder(false)}
        onSubmit={async (name) => { const r = await post('/mail/folders', { name }); toast(`Folder ${r.path} created`); loadFolders(); }} />}
      {signatureOpen && <SignatureDialog signatures={signatures} onClose={() => setSignatureOpen(false)} onSaved={(list) => setSignatures(list)} />}
      {folderDialog?.type === 'rename' && (
        <PromptModal title={`Rename “${folderDialog.folder.name}”`} label="New name (use / for subfolders)" initial={folderDialog.folder.path} confirm="Rename"
          onClose={() => setFolderDialog(null)}
          onSubmit={async (newPath) => {
            const r = await api('PATCH', '/mail/folders', { path: folderDialog.folder.path, newPath });
            get('/mail/notify-folders').then((x) => setFollowed(x.folders)).catch(() => {});
            toast(`Renamed to ${r.path}${r.updatedFilters ? ` · ${r.updatedFilters} filter${r.updatedFilters === 1 ? '' : 's'} updated` : ''}`);
            if (folder === folderDialog.folder.path || folder.startsWith(`${folderDialog.folder.path}/`)) go(r.path + folder.slice(folderDialog.folder.path.length));
            loadFolders();
          }} />
      )}
      {folderDialog?.type === 'delete' && (
        <ConfirmModal title={`Delete “${folderDialog.folder.name}”?`} confirm="Delete folder"
          message={`${folderDialog.folder.messages ? `Its ${folderDialog.folder.messages} message${folderDialog.folder.messages === 1 ? '' : 's'} will be moved to Trash. ` : ''}Subfolders are deleted too, and their messages also go to Trash. Filters that file mail here will be switched off.`}
          onClose={() => setFolderDialog(null)}
          onConfirm={async () => {
            const r = await api('DELETE', `/mail/folders?path=${enc(folderDialog.folder.path)}`);
            get('/mail/notify-folders').then((x) => setFollowed(x.folders)).catch(() => {});
            toast(['Folder deleted', r.movedToTrash && `${r.movedToTrash} message${r.movedToTrash === 1 ? '' : 's'} moved to Trash`,
              r.disabledFilters && `${r.disabledFilters} filter${r.disabledFilters === 1 ? '' : 's'} switched off`].filter(Boolean).join(' · '));
            if (folder === folderDialog.folder.path || folder.startsWith(`${folderDialog.folder.path}/`)) go('INBOX');
            loadFolders();
          }} />
      )}
      {vacationOpen && <VacationDialog onClose={() => setVacationOpen(false)} onSaved={(v) => { setVacation(v); setVacationOpen(false); }} />}
    </div>
  );
}

function Reader({ folder, uid, special, onClose, onChanged, act, onCompose, onFilter }) {
  const mailStatus = useMailStatus();
  const toast = useToast();
  const { user } = useAuth();
  const [m, setM] = useState(null);
  const [images, setImages] = useState(false);
  useEffect(() => {
    get(`/mail/messages/${uid}?folder=${enc(folder)}`).then((x) => { setM(x); onChanged(); }).catch((e) => { toast(e.message, 'error'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, uid]);
  if (!m) return <p className="muted mail-note">Loading…</p>;

  // The original's body for a reply or forward. HTML mail keeps its basic formatting and embedded
  // pictures, cleaned by the server so hostile HTML never reaches the editor; plain-text mail (or if
  // that fails) is quoted as text.
  const originalBody = async () => (m.html && await get(`/mail/messages/${uid}/quote?folder=${enc(folder)}`).then((r) => r.html).catch(() => null)) || textToHtml(m.text);
  const quoted = async () => `<p></p><p>On ${escapeHtml(new Date(m.date).toLocaleString())}, ${escapeHtml(who(m.from))} wrote:</p><blockquote>${await originalBody()}</blockquote>`;
  const reSubject = (p) => (m.subject.toLowerCase().startsWith(p.toLowerCase()) ? m.subject : `${p} ${m.subject}`);
  // Reply from the address the message was sent to (e.g. sales@), if it is one of yours.
  const mine = (mailStatus?.identities || []).map((i) => i.address);
  const replyFrom = [...m.to, ...m.cc].map((a) => a.address).find((a) => mine.includes(a)) || user.username;
  const thread = { inReplyTo: m.messageId, references: m.references, replyTo: { folder, uid }, from: replyFrom };
  const replyTo = m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
  const others = [...m.to, ...m.cc].filter((a) => !mine.includes(a.address) && a.address !== user.username && !replyTo.some((r) => r.address === a.address));
  const done = async (p, b, msg) => { if (await act(p, { uids: [uid], ...b }, msg)) onClose(); };

  return (
    <article className="reader">
      <div className="reader-actions">
        <button className="icon-btn mobile-only" aria-label="Back to list" onClick={onClose}><Icon name="back" /></button>
        {special !== '\\Archive' && <button className="icon-btn" aria-label="Archive" title="Archive" onClick={() => done('move', { to: 'archive' }, 'Archived')}><Icon name="archive" /></button>}
        {special === '\\Junk'
          ? <button className="btn small" onClick={() => done('move', { to: 'inbox' }, 'Moved to Inbox')}>Not spam</button>
          : <button className="icon-btn" aria-label="Report spam" title="Report spam" onClick={() => done('move', { to: 'junk' }, 'Moved to Junk')}><Icon name="report" /></button>}
        <button className="icon-btn" aria-label="Delete" title="Delete" onClick={() => done('delete', {}, special === '\\Trash' ? 'Deleted forever' : 'Moved to Trash')}><Icon name="trash" /></button>
        <button className="icon-btn" aria-label="Mark unread" title="Mark unread" onClick={() => done('flags', { seen: false })}><Icon name="markunread" /></button>
        <button className={`icon-btn ${m.flagged ? 'starred' : ''}`} aria-label={m.flagged ? 'Unstar' : 'Star'} aria-pressed={m.flagged} title="Star"
          onClick={async () => { if (await act('flags', { uids: [uid], flagged: !m.flagged })) setM({ ...m, flagged: !m.flagged }); }}>
          <span aria-hidden="true" style={{ fontSize: 20 }}>{m.flagged ? '★' : '☆'}</span>
        </button>
        {m.from?.address && <button className="btn small" onClick={() => onFilter(m.from.address)}>Filter messages like this</button>}
      </div>
      <h1 className="reader-subject">{m.subject || '(no subject)'}</h1>
      {m.spam && <div className="banner warn">This message was marked as likely spam. Be careful with links and attachments.</div>}
      <div className="reader-head">
        <Avatar name={who(m.from)} size={40} />
        <div className="grow">
          <div><strong>{m.from?.name || m.from?.address}</strong> {m.from?.name && <span className="muted small">&lt;{m.from.address}&gt;</span>}</div>
          <div className="muted small">to {list(m.to) || '—'}{m.cc.length > 0 && <> · cc {list(m.cc)}</>}</div>
        </div>
        <span className="muted small nowrap">{m.date ? new Date(m.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>
      </div>
      {m.html ? <HtmlBody html={m.html} images={images} onShowImages={() => setImages(true)} /> : <pre className="mail-text">{m.text}</pre>}
      {m.attachments.length > 0 && (
        <ul className="att-list">
          {m.attachments.map((a) => (
            <li key={a.index}><a className="att" href={`/api/mail/messages/${uid}/attachments/${a.index}?folder=${enc(folder)}`}>
              <Icon name="attach" size={18} /><span className="ellipsis">{a.filename}</span><span className="muted small">{formatBytes(a.size)}</span>
            </a></li>
          ))}
        </ul>
      )}
      <div className="row wrap reader-reply">
        <button className="btn" onClick={async () => onCompose({ to: list(replyTo), subject: reSubject('Re:'), html: await quoted(), ...thread })}><Icon name="reply" size={18} /> Reply</button>
        {others.length > 0 && <button className="btn" onClick={async () => onCompose({ to: list(replyTo), cc: list(others), subject: reSubject('Re:'), html: await quoted(), ...thread })}><Icon name="replyall" size={18} /> Reply all</button>}
        <button className="btn" onClick={() => onCompose({
          from: replyFrom, subject: reSubject('Fwd:'), html: '<p></p>',
          forwardOf: { folder, uid, asEml: true, attachments: [], eml: { filename: `${(m.subject || 'message').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'message'}.eml` } },
        })}><Icon name="attach" size={18} /> Forward as attachment</button>
        <button className="btn" onClick={async () => {
          const body = await originalBody();
          onCompose({
            from: replyFrom,
            ...(m.attachments.length > 0 && { forwardOf: { folder, uid, attachments: m.attachments.map((a) => a.index), files: m.attachments } }),
            subject: reSubject('Fwd:'),
            html: `<p></p><p>---------- Forwarded message ----------<br>From: ${escapeHtml(list([m.from]))}<br>Date: ${escapeHtml(new Date(m.date).toLocaleString())}<br>Subject: ${escapeHtml(m.subject)}<br>To: ${escapeHtml(list(m.to))}</p>${body}`,
          });
        }}><Icon name="forward" size={18} /> Forward</button>
      </div>
    </article>
  );
}

/** HTML mail in a locked-down iframe: no scripts, no same-origin access, remote images blocked until asked. */
function HtmlBody({ html, images, onShowImages }) {
  const ref = useRef();
  const [height, setHeight] = useState(300);
  const hasRemote = useMemo(() => /<img[^>]+src=["']?https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html), [html]);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${images ? ' https: http:' : ''}`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank"><style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#1f1f1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
  return (
    <>
      {hasRemote && !images && (
        <div className="banner">Images from the internet are hidden to protect your privacy. <button className="btn small" onClick={onShowImages}>Show images</button></div>
      )}
      <iframe ref={ref} className="mail-html" title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin" srcDoc={doc} style={{ height }}
        onLoad={() => { try { setHeight(Math.min(20000, ref.current.contentDocument.documentElement.scrollHeight + 16)); } catch { setHeight(800); } }} />
    </>
  );
}

const FIELDS = ['from', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'inReplyTo', 'references', 'replyTo'];

function Compose({ initial, signatures = [], onClose, onSent, onDraftsChanged }) {
  const editorRef = useRef(null);
  const toast = useToast();
  const { user } = useAuth();
  const [identities, setIdentities] = useState([{ address: user.username }]);
  const [f, setF] = useState(() => {
    const base = { from: user.username, to: '', cc: '', bcc: '', subject: '', text: '', html: '' };
    for (const k of FIELDS) if (initial[k] !== undefined && initial[k] !== null) base[k] = initial[k];
    return base;
  });
  const [showCc, setShowCc] = useState(!!(initial.cc || initial.bcc));
  const [files, setFiles] = useState(initial.files || []);
  // Attachments carried over from a forwarded message (attached by the server from the original).
  const [fwd, setFwd] = useState(initial.forwardOf || null);
  const [draftState, setDraftState] = useState(initial.draftUid ? 'saved' : '');

  // ---- autosave to the Drafts folder: debounced, one save at a time, each replacing the previous copy ----
  const draftUid = useRef(initial.draftUid || null);
  const chain = useRef(Promise.resolve());
  const timer = useRef(null);
  const dirty = useRef(false);
  const closed = useRef(false);
  const latest = useRef({ f, files });
  latest.current = { f, files, fwd };

  const saveDraft = useCallback(() => {
    clearTimeout(timer.current);
    if (!dirty.current || closed.current) return chain.current;
    dirty.current = false;
    const { f: cur, files: att, fwd: fw } = latest.current;
    const empty = !cur.to.trim() && !cur.cc.trim() && !cur.bcc.trim() && !cur.subject.trim() && !cur.text.trim() && !att.length;
    if (empty && !draftUid.current) return chain.current;
    chain.current = chain.current.then(async () => {
      setDraftState('saving');
      try {
        const r = await post('/mail/drafts', { ...cur, attachments: att.map((x) => x.id), uid: draftUid.current, forwardOf: fw });
        draftUid.current = r.uid;
        setDraftState('saved');
      } catch { dirty.current = true; setDraftState('error'); }
    });
    return chain.current;
  }, []);

  const first = useRef(true);
  const skipNext = useRef(false); // the editor reporting its starting content is not an edit
  useEffect(() => {
    if (first.current || skipNext.current) { first.current = false; skipNext.current = false; return; }
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(saveDraft, 2000);
  }, [f, files, fwd, saveDraft]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function closeKeep() {
    if (busy) return;
    await saveDraft();
    closed.current = true;
    if (draftUid.current) { toast('Draft saved'); onDraftsChanged?.(); }
    onClose();
  }
  async function discard() {
    closed.current = true;
    clearTimeout(timer.current);
    await chain.current;
    if (draftUid.current) { await del(`/mail/drafts/${draftUid.current}`).catch(() => {}); onDraftsChanged?.(); toast('Draft discarded'); }
    onClose();
  }
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { get('/mail/status').then((s) => setIdentities(s.identities)).catch(() => {}); }, []);

  async function send(e) {
    e.preventDefault();
    // Only this form's own submit sends. Dialogs opened from the message (e.g. the link dialog) are
    // rendered elsewhere in the page, but React still passes their events up to here.
    if (e.target !== e.currentTarget) return;
    setBusy(true);
    closed.current = true;          // no more autosaves
    clearTimeout(timer.current);
    await chain.current;            // let an in-flight save finish so the right draft gets removed
    try {
      const r = await post('/mail/send', { ...f, html: f.text.trim() ? emailHtml(f.html) : '', attachments: files.map((x) => x.id), draftUid: draftUid.current, forwardOf: fwd });
      toast(`Sent to ${r.recipients} recipient${r.recipients === 1 ? '' : 's'}`);
      onSent();
    } catch (err) { toast(err.message, 'error'); setBusy(false); closed.current = false; dirty.current = true; }
  }

  async function upload(list) {
    for (const file of list) {
      setUploading((n) => n + 1);
      try { const rec = await uploadFile(file, null); setFiles((x) => [...x, rec]); }
      catch (err) { toast(err.message, 'error'); }
      finally { setUploading((n) => n - 1); }
    }
  }

  const total = files.reduce((s, x) => s + x.size, 0);
  return (
    <Modal wide title={initial.draftUid ? 'Draft' : initial.subject ? initial.subject : 'New message'} onClose={closeKeep}>
      <form className="compose stack" onSubmit={send}>
        {identities.length > 1 && (
          <label className="compose-line"><span>From</span>
            <select aria-label="From" value={f.from} onChange={(e) => {
              const from = e.target.value;
              const kind = initial.kind || ((f.html || '').includes('<blockquote') ? 'reply' : 'new'); // resumed drafts
              if (editorRef.current) swapSignature(editorRef.current, signatureBlock(signatures, from, kind));
              setF((cur) => ({ ...cur, from }));
            }}>{identities.map((i) => <option key={i.address} value={i.address}>{i.address}</option>)}</select>
          </label>
        )}
        <label className="compose-line"><span>To</span><input aria-label="To" autoFocus={!initial.to} type="text" inputMode="email" value={f.to} onChange={set('to')} placeholder="name@company.com, …" />
          {!showCc && <button type="button" className="link" onClick={() => setShowCc(true)}>Cc/Bcc</button>}</label>
        {showCc && <>
          <label className="compose-line"><span>Cc</span><input aria-label="Cc" type="text" inputMode="email" value={f.cc} onChange={set('cc')} /></label>
          <label className="compose-line"><span>Bcc</span><input aria-label="Bcc" type="text" inputMode="email" value={f.bcc} onChange={set('bcc')} /></label>
        </>}
        <label className="compose-line"><span>Subject</span><input aria-label="Subject" value={f.subject} onChange={set('subject')} /></label>
        <RichBody initialHtml={initial.html || textToHtml(initial.text || '')} autoFocus={!!initial.to} onReady={(ed) => { editorRef.current = ed; }}
          onChange={(html, text, initialReport) => { if (initialReport) skipNext.current = true; setF((cur) => ({ ...cur, html, text })); }} />
        {fwd?.asEml && (
          <ul className="att-list" aria-label="Forwarded message">
            <li className="att"><Icon name="mail" size={18} /><span className="ellipsis">{fwd.eml?.filename || 'message.eml'}</span><span className="muted small">original message</span>
              <button type="button" className="icon-btn" aria-label="Remove the attached message" onClick={() => setFwd({ ...fwd, asEml: false })}><Icon name="close" size={16} /></button></li>
          </ul>
        )}
        {fwd?.attachments?.length > 0 && (
          <ul className="att-list" aria-label="Forwarded attachments">
            {(fwd.files || []).filter((x) => fwd.attachments.includes(x.index)).map((x) => (
              <li key={`fwd-${x.index}`} className="att"><Icon name="attach" size={18} /><span className="ellipsis">{x.filename}</span><span className="muted small">{formatBytes(x.size)}</span>
                <button type="button" className="icon-btn" aria-label={`Remove ${x.filename}`}
                  onClick={() => setFwd({ ...fwd, attachments: fwd.attachments.filter((i) => i !== x.index) })}><Icon name="close" size={16} /></button></li>
            ))}
          </ul>
        )}
        {(files.length > 0 || uploading > 0) && (
          <ul className="att-list">
            {files.map((x) => (
              <li key={x.id} className="att"><Icon name="attach" size={18} /><span className="ellipsis">{x.name}</span><span className="muted small">{formatBytes(x.size)}</span>
                <button type="button" className="icon-btn" aria-label={`Remove ${x.name}`} onClick={() => setFiles(files.filter((y) => y.id !== x.id))}><Icon name="close" size={16} /></button></li>
            ))}
            {uploading > 0 && <li className="att muted">Uploading {uploading}…</li>}
          </ul>
        )}
        {total > 25 * 1024 * 1024 && <p className="error small">Attachments are over 25 MB. Share a Drive link instead.</p>}
        <div className="row">
          <button className="btn primary" disabled={busy || uploading > 0 || !f.to.trim() || total > 25 * 1024 * 1024}><Icon name="send" size={18} /> {busy ? 'Sending…' : 'Send'}</button>
          <button type="button" className="icon-btn" aria-label="Attach from computer" title="Attach from computer" onClick={() => fileInput.current.click()}><Icon name="attach" /></button>
          <button type="button" className="icon-btn" aria-label="Attach from Drive" title="Attach from Drive" onClick={() => setPicking(true)}><Icon name="folder" /></button>
          <input ref={fileInput} type="file" multiple hidden aria-label="Attachment files" onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
          <div className="grow" />
          <span className={`muted small draft-state ${draftState}`} aria-live="polite">
            {draftState === 'saving' ? 'Saving…' : draftState === 'saved' ? 'Draft saved' : draftState === 'error' ? 'Couldn’t save draft' : ''}
          </span>
          <button type="button" className="icon-btn" aria-label="Discard draft" title="Discard draft" onClick={discard}><Icon name="trash" /></button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Drafts save automatically. Files you attach from your computer are also saved to your Drive.</p>
      </form>
      {picking && <DrivePicker onClose={() => setPicking(false)} onPick={(file) => { if (!files.some((x) => x.id === file.id)) setFiles([...files, file]); setPicking(false); }} />}
    </Modal>
  );
}

function DrivePicker({ onClose, onPick }) {
  const [items, setItems] = useState(null);
  const [term, setTerm] = useState('');
  useEffect(() => {
    const url = term ? `/files?view=search&q=${enc(term)}` : '/files?view=recent';
    const t = setTimeout(() => get(url).then((l) => setItems(l.filter((x) => x.kind === 'file'))), term ? 250 : 0);
    return () => clearTimeout(t);
  }, [term]);
  return (
    <Modal title="Attach from Drive" onClose={onClose}>
      <input className="filter" style={{ width: '100%' }} placeholder="Search your files" aria-label="Search your files" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus />
      <ul className="pick-list">
        {items === null && <li className="muted">Loading…</li>}
        {items?.length === 0 && <li className="muted">No files found. (Docs and Sheets can't be attached yet; download them first.)</li>}
        {items?.map((x) => <li key={x.id}><button onClick={() => onPick(x)}><Icon name="file" />{x.name}<span className="muted small">{formatBytes(x.size)}</span></button></li>)}
      </ul>
    </Modal>
  );
}

function VacationDialog({ onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { get('/mail/vacation').then((x) => setV({ ...x, start_date: x.start_date || '', end_date: x.end_date || '' })); }, []);
  if (!v) return null;
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title="Vacation reply" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        if (e.target !== e.currentTarget) return; // a dialog opened from inside (see Compose's send)
        try { const r = await put('/mail/vacation', v); toast(r.enabled ? 'Vacation reply saved' : 'Vacation reply off'); onSaved(r); }
        catch (err) { setError(err.message); }
      }}>
        <label className="check"><input type="checkbox" checked={v.enabled} onChange={set('enabled')} /> Send an automatic reply while I'm away</label>
        <div className="row wrap">
          <label className="field"><span>First day (optional)</span><input type="date" value={v.start_date} onChange={set('start_date')} /></label>
          <label className="field"><span>Last day (optional)</span><input type="date" value={v.end_date} min={v.start_date || undefined} onChange={set('end_date')} /></label>
        </div>
        <label className="field"><span>Subject</span><input value={v.subject} onChange={set('subject')} maxLength={200} /></label>
        <label className="field"><span>Message</span><textarea rows={6} value={v.body} onChange={set('body')} required={v.enabled}
          placeholder="I'm out of the office until Monday and will reply when I'm back." /></label>
        <p className="muted small" style={{ margin: 0 }}>Each person gets this reply at most once a day. Mailing lists, newsletters, spam and other automatic messages never get one.</p>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

/** Rich-text message body: bold, italic, underline, strike, lists, quotes, links. */
function RichBody({ initialHtml, onChange, onReady, autoFocus, label = 'Message', placeholder = 'Write your message…' }) {
  const [, force] = useState(0);
  const toast = useToast();
  const fileInput = useRef();
  const [uploading, setUploading] = useState(0);
  const edRef = useRef(null);
  const [editing, setEditing] = useState(null); // { pos, src, alt } of the picture open in the editor
  const [linking, setLinking] = useState(null); // { from, to, text, href } for the link dialog
  const linkOpen = useRef(() => {});

  // Pictures are uploaded to Drive, shown from there while writing, and embedded in the email when sent.
  async function insertImages(files, pos) {
    const images = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!images.length) return false;
    for (const file of images) {
      if (file.size > 10 * 1024 * 1024) { toast(`${file.name} is larger than 10 MB`, 'error'); continue; }
      setUploading((n) => n + 1);
      try {
        const rec = await uploadFile(file, null);
        // Insert the picture followed by an empty line, and leave the cursor there, so typing or
        // pasting next doesn't replace the picture (an inserted image is otherwise left selected).
        const content = [{ type: 'image', attrs: { src: `/api/files/${rec.id}/raw`, alt: rec.name } }, { type: 'paragraph' }];
        const chain = edRef.current.chain().focus();
        (pos != null ? chain.insertContentAt(pos, content) : chain.insertContent(content)).run();
      } catch (e) { toast(e.message, 'error'); }
      finally { setUploading((n) => n - 1); }
    }
    return true;
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
      Placeholder.configure({ placeholder }),
      ResizableImage.configure({ inline: false, allowBase64: false }),
      // Tables quoted from replies and forwards (or pasted). Column sizes follow the content.
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      // Text colours quoted from replies and forwards (or pasted). Clear formatting removes them.
      // Highlights are a background colour on the text (inline style), which every mail app shows.
      // Fonts are kept from quoted mail (the server only lets common mail fonts through).
      TextStyle, Color, BackgroundColor, FontSize, FontFamily,
      // Left / centre / right for paragraphs (Ctrl+Shift+L / E / R). Left is the normal alignment.
      TextAlign.configure({ types: ['paragraph'], alignments: ['left', 'center', 'right'] }),
      Indent,
      SignatureBlock,
    ],
    content: initialHtml,
    editorProps: {
      attributes: { class: 'tiptap', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (view, event) => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); linkOpen.current(); return true; }
        return false;
      },
      handlePaste: (view, event) => {
        const files = event.clipboardData?.files;
        if (files?.length && [...files].some((f) => f.type.startsWith('image/'))) { event.preventDefault(); insertImages(files); return true; }
        return false;
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files?.length || ![...files].some((f) => f.type.startsWith('image/'))) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        insertImages(files, pos);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const doc = ed.getJSON();
      onChange(isEmptyDoc(doc) ? '' : ed.getHTML(), docToText(doc));
    },
    onSelectionUpdate: () => force((n) => n + 1),
    onTransaction: () => force((n) => n + 1),
  });
  useEffect(() => {
    if (!editor) return;
    edRef.current = editor;
    onReady?.(editor);
    // Report the starting content (e.g. a quoted reply) so drafts and sending see it.
    const doc = editor.getJSON();
    onChange(isEmptyDoc(doc) ? '' : editor.getHTML(), docToText(doc), true);
    if (autoFocus) editor.commands.focus('start');
    // Double-clicking a picture opens the crop / rotate editor.
    const onEdit = () => openEditor(editor);
    editor.on('editPicture', onEdit);
    return () => editor.off('editPicture', onEdit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  function openEditor(ed) {
    const sel = ed.state.selection;
    const node = sel.node;
    if (node?.type.name !== 'image') return;
    if (!editablePicture(node.attrs.src)) return toast('Only pictures you inserted can be edited', 'error');
    setEditing({ pos: sel.from, src: node.attrs.src, alt: node.attrs.alt });
  }
  // Swap in the edited picture, keeping its size. Ctrl+Z puts the original back.
  function applyEdit({ src, alt }) {
    const ed = edRef.current;
    const { pos } = editing;
    const node = ed.state.doc.nodeAt(pos);
    setEditing(null);
    if (node?.type.name !== 'image' || node.attrs.src !== editing.src) return toast('The picture was moved; edit it again', 'error');
    // Its own undo step, even right after another change to the picture.
    ed.view.dispatch(closeHistory(ed.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src, alt })));
    ed.commands.setNodeSelection(pos);
    ed.commands.focus();
  }
  if (!editor) return null;
  const c = () => editor.chain().focus();
  // Link dialog: for the link the cursor is in (whole link), or for the selected text.
  linkOpen.current = () => {
    if (editor.isActive('link')) editor.chain().extendMarkRange('link').run();
    const { from, to } = editor.state.selection;
    setLinking({ from, to, text: editor.state.doc.textBetween(from, to, ' '), href: editor.getAttributes('link').href || '' });
  };
  const applyLink = ({ text, href }) => {
    const { from, to, text: old } = linking;
    setLinking(null);
    const ch = editor.chain().focus().setTextSelection({ from, to });
    if (text && text !== old) {
      // New or changed text: put it in with the link (keeping the formatting where the text starts).
      const marks = editor.state.doc.resolve(from).marks().filter((m) => m.type.name !== 'link').map((m) => m.toJSON());
      ch.insertContentAt({ from, to }, { type: 'text', text, marks: [...marks, { type: 'link', attrs: { href } }] }).run();
    } else {
      ch.extendMarkRange('link').setLink({ href }).run();
    }
  };
  const removeLink = () => {
    const { from, to } = linking;
    setLinking(null);
    editor.chain().focus().setTextSelection({ from, to }).extendMarkRange('link').unsetLink().run();
  };
  // Popups give focus back to the message straight away when something is picked (the editor's own
  // focus() waits for the next frame, and a key pressed in between would be lost).
  const refocus = () => { try { editor.view.focus(); } catch { /* not mounted */ } };
  const B = ({ label, title, active, onClick, disabled, toggle = true }) => (
    <button type="button" className={`tb ${active ? 'on' : ''}`} title={title} aria-label={title} aria-pressed={toggle ? !!active : undefined}
      disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  return (
    <div className="compose-editor">
      <div className="toolbar compose-toolbar" role="toolbar" aria-label="Formatting">
        <B label={<UndoIcon />} title="Undo (Ctrl+Z)" toggle={false} disabled={!editor.can().undo()} onClick={() => c().undo().run()} />
        <B label={<UndoIcon redo />} title="Redo (Ctrl+Y)" toggle={false} disabled={!editor.can().redo()} onClick={() => c().redo().run()} />
        <span className="sep" />
        <select className="tb-select" aria-label="Font" title="Font" value={fontName(editor.getAttributes('textStyle').fontFamily)}
          onChange={(e) => { const stack = FONTS.find(([n]) => n === e.target.value)?.[1]; (stack ? c().setFontFamily(stack) : c().unsetFontFamily()).run(); }}>
          {FONTS.map(([n, stack]) => <option key={n} value={n} style={stack ? { fontFamily: stack } : undefined}>{n}</option>)}
          {fontName(editor.getAttributes('textStyle').fontFamily) === 'Other font' && <option value="Other font" disabled>Other font</option>}
        </select>
        <select className="tb-select" aria-label="Font size" title="Font size" value={sizeName(editor.getAttributes('textStyle').fontSize)}
          onChange={(e) => { const px = FONT_SIZES.find(([n]) => n === e.target.value)?.[1]; (px ? c().setFontSize(px) : c().unsetFontSize()).run(); }}>
          {FONT_SIZES.map(([n]) => <option key={n} value={n}>{n}</option>)}
          {sizeName(editor.getAttributes('textStyle').fontSize) === 'Other' && <option value="Other" disabled>Other size</option>}
        </select>
        <span className="sep" />
        <B label={<b>B</b>} title="Bold" active={editor.isActive('bold')} onClick={() => c().toggleBold().run()} />
        <B label={<i>I</i>} title="Italic" active={editor.isActive('italic')} onClick={() => c().toggleItalic().run()} />
        <B label={<u>U</u>} title="Underline" active={editor.isActive('underline')} onClick={() => c().toggleUnderline().run()} />
        <ColorPicker refocus={refocus} label="Text colour" kind="text" options={TEXT_COLORS} none="Automatic" current={editor.getAttributes('textStyle').color || null}
          icon={(shown) => <span className="color-a">A<span className="color-bar" style={{ background: shown || 'currentColor' }} /></span>}
          onPick={(color) => (color ? c().setColor(color).run() : c().unsetColor().run())} />
        <ColorPicker refocus={refocus} label="Highlight colour" kind="highlight" options={HIGHLIGHTS} none="None" current={editor.getAttributes('textStyle').backgroundColor || null}
          icon={(shown) => <span className="color-a hl"><span className="hl-pen" aria-hidden="true">🖍</span><span className="color-bar" style={{ background: shown || 'transparent' }} /></span>}
          onPick={(color) => (color ? c().setBackgroundColor(color).run() : c().unsetBackgroundColor().run())} />
        <span className="sep" />
        {(() => {
          // One button for alignment, showing the current one. With a picture selected it aligns the
          // picture; otherwise the paragraph.
          const pic = editor.isActive('image');
          const now = pic ? editor.getAttributes('image').align || 'left' : editor.isActive({ textAlign: 'center' }) ? 'center' : editor.isActive({ textAlign: 'right' }) ? 'right' : 'left';
          const names = { left: 'Align left', center: 'Centre', right: 'Align right' };
          return (
            <MenuButton refocus={refocus} label={pic ? 'Picture alignment' : 'Alignment'} icon={<AlignIcon to={now} />} items={['left', 'center', 'right'].map((al) => ({
              label: pic ? `${names[al]} (picture)` : names[al], icon: <AlignIcon to={al} />, checked: now === al, radio: true,
              onSelect: () => (pic ? c().updateAttributes('image', { align: al === 'left' ? null : al }) : al === 'left' ? c().unsetTextAlign() : c().setTextAlign(al)).run(),
            }))} />
          );
        })()}
        <B label="•" title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()} />
        <B label="1." title="Numbered list" active={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()} />
        <span className="sep" />
        <B label="🔗" title={editor.isActive('link') ? 'Edit link (Ctrl+K)' : 'Insert link (Ctrl+K)'} active={editor.isActive('link')} onClick={() => linkOpen.current()} />
        <B label="🖼" title="Insert picture" onClick={() => fileInput.current.click()} />
        <EmojiPicker keepFocus beforePick={refocus} onPick={(ch) => c().insertContent(ch).run()} />
        <TablePicker refocus={refocus} disabled={editor.isActive('table')} onPick={(rows, cols, withHeaderRow) => c().insertTable({ rows, cols, withHeaderRow }).run()} />
        <MenuButton refocus={refocus} end label="More formatting" icon={<span aria-hidden="true">⋮</span>} items={[
          { label: 'Strikethrough', icon: <s>S</s>, checked: editor.isActive('strike'), onSelect: () => c().toggleStrike().run() },
          { label: 'Quote', icon: '❝', checked: editor.isActive('blockquote'), onSelect: () => c().toggleBlockquote().run() },
          { label: 'Decrease indent (Ctrl+[)', icon: <IndentIcon out />, onSelect: () => c().outdent().run() },
          { label: 'Increase indent (Ctrl+])', icon: <IndentIcon />, onSelect: () => c().indent().run() },
          { label: 'Clear formatting', icon: 'Tx', onSelect: () => c().unsetAllMarks().clearNodes().run() },
        ]} />
        {editor.isActive('image') && (
          <span className="img-sizes" role="group" aria-label="Picture size">
            <span className="sep" />
            {IMAGE_SIZES.map(([w, name]) => (
              <B key={w} label={name} title={`${name} picture (${w}% of the message width)`} active={(editor.getAttributes('image').width || 100) === w}
                onClick={() => c().updateAttributes('image', { width: w === 100 ? null : w }).run()} />
            ))}
            {editablePicture(editor.getAttributes('image').src) && (
              <B label="✂ Crop / rotate" title="Crop or rotate picture" onClick={() => openEditor(editor)} />
            )}
          </span>
        )}
        {editor.isActive('table') && (
          <span className="img-sizes" role="group" aria-label="Table">
            <span className="sep" />
            <B label="+ Row" title="Add a row below" onClick={() => c().addRowAfter().run()} />
            <B label="− Row" title="Delete this row" onClick={() => c().deleteRow().run()} />
            <B label="+ Column" title="Add a column to the right" onClick={() => c().addColumnAfter().run()} />
            <B label="− Column" title="Delete this column" onClick={() => c().deleteColumn().run()} />
            <B label="Delete table" title="Delete table" onClick={() => c().deleteTable().run()} />
          </span>
        )}
        {uploading > 0 && <span className="muted small">Uploading picture…</span>}
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label="Picture file"
          onChange={(e) => { insertImages(e.target.files); e.target.value = ''; }} />
      </div>
      <EditorContent editor={editor} />
      {/* Outside the Compose form, so the editor's buttons never submit (send) the message. */}
      {linking && createPortal(<LinkDialog initial={linking} onApply={applyLink} onRemove={linking.href ? removeLink : null}
        onClose={() => { setLinking(null); editor.commands.focus(); }} />, document.body)}
      {editing && createPortal(<ImageEditor src={editing.src} alt={editing.alt} onClose={() => { setEditing(null); editor.commands.focus(); }} onDone={applyEdit} />, document.body)}
    </div>
  );
}

// Pictures inserted from Drive, or carried over from a forwarded message.
/** Escape anywhere in a toolbar popup (its button included) closes just the popup and returns to its button. */
/** Shift a just-opened popup sideways so it stays on screen (toolbars wrap on phones). */
function keepOnScreen(el) {
  if (!el) return;
  el.style.transform = '';
  const r = el.getBoundingClientRect();
  const room = document.documentElement.clientWidth - 8;
  const dx = r.right > room ? room - r.right : r.left < 8 ? 8 - r.left : 0;
  if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
}

/**
 * Enter, Space or Down on a toolbar popup's button opens it. The key is handled here (default
 * cancelled), so the same key press can't also activate the item that receives focus.
 */
const keyOpens = (open, setOpen) => (e) => {
  if (open || !['Enter', ' ', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  setOpen(true);
};

const escCloses = (open, setOpen, wrap) => (e) => {
  if (!open || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation(); // not the message window
  setOpen(false);
  wrap.current?.querySelector('button')?.focus();
};

// Text colours that read well on a white page (and in mail apps' dark modes).
const TEXT_COLORS = [
  ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#00796b', 'Teal'], ['#1a73e8', 'Blue'],
  ['#174ea6', 'Dark blue'], ['#8430ce', 'Purple'], ['#d01884', 'Pink'], ['#795548', 'Brown'], ['#5f6368', 'Grey'],
];
// Fonts: the same font lists the server keeps when quoting mail, so quoted fonts show by name.
// Each lists fallbacks for computers that don't have the font.
const FONTS = [
  ['Sans Serif', null], ['Georgia', 'Georgia, serif'], ['Times New Roman', "'Times New Roman', Times, serif"], ['Garamond', 'Garamond, Georgia, serif'],
  ['Courier New', "'Courier New', Courier, monospace"], ['Verdana', 'Verdana, sans-serif'], ['Tahoma', 'Tahoma, sans-serif'],
  ['Trebuchet MS', "'Trebuchet MS', sans-serif"], ['Calibri', 'Calibri, Arial, sans-serif'], ['Comic Sans MS', "'Comic Sans MS', cursive"],
];
const fontKey = (v) => String(v || '').replace(/['"\s]/g, '').toLowerCase();
const fontName = (v) => (!v ? 'Sans Serif' : FONTS.find(([, stack]) => stack && fontKey(stack) === fontKey(v))?.[0] || 'Other font');

const MAX_INDENT = 8, INDENT_PX = 40;
const clampIndent = (n) => Math.max(0, Math.min(MAX_INDENT, Math.round(n) || 0));

/**
 * Paragraph indent, 40px a step (up to 8), sent as a left margin that mail apps show.
 * In a list the same commands nest / un-nest the item. Ctrl+] / Ctrl+[ (Tab stays free for
 * moving out of the message with the keyboard).
 */
const Indent = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        indent: {
          default: 0,
          parseHTML: (el) => {
            const d = Number(el.getAttribute('data-indent'));
            if (d) return clampIndent(d);
            const m = /^([\d.]+)px$/.exec(el.style.marginLeft || '');
            return m ? clampIndent(parseFloat(m[1]) / INDENT_PX) : 0;
          },
          renderHTML: (attrs) => (attrs.indent ? { 'data-indent': attrs.indent, style: `margin-left: ${attrs.indent * INDENT_PX}px` } : {}),
        },
      },
    }];
  },
  addCommands() {
    const change = (delta) => () => ({ state, tr, dispatch, commands, editor }) => {
      if (editor.isActive('listItem')) return delta > 0 ? commands.sinkListItem('listItem') : commands.liftListItem('listItem');
      let changed = false;
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.type.name !== 'paragraph') return true;
        const next = clampIndent((node.attrs.indent || 0) + delta);
        if (next !== (node.attrs.indent || 0)) {
          changed = true;
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
        }
        return false;
      });
      return changed;
    };
    return { indent: change(1), outdent: change(-1) };
  },
  addKeyboardShortcuts() {
    return { 'Mod-]': () => this.editor.commands.indent(), 'Mod-[': () => this.editor.commands.outdent() };
  },
});

function IndentIcon({ out }) {
  return (
    <svg width="16" height="16" viewBox="0 0 18 16" aria-hidden="true" fill="currentColor">
      {[0, 1, 2, 3].map((i) => <rect key={i} x={i === 0 || i === 3 ? 2 : 8} y={2 + i * 3.5} width={i === 0 || i === 3 ? 14 : 8} height="1.8" rx=".9" />)}
      <path d={out ? 'M5.5 6.2 2.5 8.6l3 2.4z' : 'M2.5 6.2l3 2.4-3 2.4z'} />
    </svg>
  );
}

/**
 * A toolbar button with a small menu (alignment, more formatting). Enter / Space / Down open it,
 * the arrow keys move, Enter picks, Escape closes it and returns to the button. Choices that can
 * be on or off show as checked.
 */
function MenuButton({ label, icon, items, end, refocus }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef();
  const menu = useRef();
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    keepOnScreen(menu.current);
    const list = [...(menu.current?.querySelectorAll('[role^="menuitem"]') || [])];
    (list.find((el) => el.getAttribute('aria-checked') === 'true' && el.getAttribute('role') === 'menuitemradio') || list[0])?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const onKey = (e) => {
    escCloses(open, setOpen, wrap)(e);
    if (!open || e.defaultPrevented) return;
    const list = [...(menu.current?.querySelectorAll('[role^="menuitem"]') || [])];
    const i = list.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: -99, End: 99 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    list[Math.max(0, Math.min(list.length - 1, (i < 0 ? (step > 0 ? -1 : list.length) : i) + step))]?.focus();
  };
  return (
    <span className="tb-menu" ref={wrap} onKeyDown={onKey}>
      <button type="button" className={`tb ${open ? 'on' : ''}`} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} onKeyDown={keyOpens(open, setOpen)}>
        {icon}<span className="tb-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={`tb-menu-pop ${end ? 'end' : ''}`} role="menu" aria-label={label} ref={menu}>
          {items.map((it) => (
            <button type="button" key={it.label} role={it.radio ? 'menuitemradio' : it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked !== undefined ? !!it.checked : undefined} aria-label={it.label} className={`tb-menu-item ${it.checked ? 'on' : ''}`}
              onMouseDown={(e) => e.preventDefault()} onClick={() => { setOpen(false); refocus?.(); it.onSelect(); }}>
              <span className="tb-menu-icon" aria-hidden="true">{it.icon}</span>{it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function UndoIcon({ redo }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      style={redo ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M5.5 4 2.5 7l3 3" /><path d="M2.8 7H10a3.5 3.5 0 0 1 0 7H7.5" />
    </svg>
  );
}

/** Lines icon for the alignment buttons. */
function AlignIcon({ to }) {
  const x = (w) => (to === 'left' ? 2 : to === 'right' ? 16 - w : (18 - w) / 2);
  return (
    <svg width="16" height="16" viewBox="0 0 18 16" aria-hidden="true" fill="currentColor">
      {[14, 9, 14, 9].map((w, i) => <rect key={i} x={x(w)} y={2 + i * 3.5} width={w} height="1.8" rx=".9" />)}
    </svg>
  );
}

// Font sizes (as in most mail apps). "Normal" means no size of its own.
const FONT_SIZES = [['Small', '12px'], ['Normal', null], ['Large', '18px'], ['Huge', '24px']];
const sizeName = (v) => (!v ? 'Normal' : FONT_SIZES.find(([, px]) => px === String(v).replace(/\s/g, ''))?.[0] || 'Other');

// Highlights: light enough that text stays readable on them (and on a white page).
const HIGHLIGHTS = [
  ['#fef08a', 'Yellow'], ['#bbf7d0', 'Green'], ['#bfdbfe', 'Blue'], ['#fbcfe8', 'Pink'],
  ['#fed7aa', 'Orange'], ['#e9d5ff', 'Purple'], ['#e5e7eb', 'Grey'],
];
const toHex = (v) => {
  const m = String(v || '').match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  return m ? `#${m.slice(1).map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : String(v || '').toLowerCase();
};
/** "#abc", "abc", "#aabbcc" -> "#aabbcc"; anything else -> null. */
const normHex = (v) => {
  const m = String(v || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h.split('').map((c) => c + c).join('') : h}`;
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Custom colours you used recently, per palette, in this browser.
const recentKey = (kind) => `nw.recentColors.${kind}`;
const loadRecent = (kind) => { try { return (JSON.parse(localStorage.getItem(recentKey(kind))) || []).map(normHex).filter(Boolean).slice(0, 6); } catch { return []; } };
const saveRecent = (kind, hex, palette) => {
  if (palette.some(([v]) => v === hex)) return;
  try { localStorage.setItem(recentKey(kind), JSON.stringify([hex, ...loadRecent(kind).filter((h) => h !== hex)].slice(0, 6))); } catch { /* private window */ }
};

const sameColor = (a, b) => !!a && toHex(a) === toHex(b);

/**
 * Text or highlight colour: the button shows the colour at the cursor; the palette sets it on the
 * selection (or on what you type next). The first choice ("Automatic" / "None") removes it.
 * Arrow keys move, Enter picks, Escape closes.
 */
function ColorPicker({ label, kind, options: colors, none, icon, current, onPick, refocus }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState(() => loadRecent(kind));
  const [custom, setCustom] = useState('');
  const wrap = useRef();
  const list = useRef();
  const options = [[null, none], ...colors, ...recent.filter((h) => !colors.some(([v]) => v === h)).map((h) => [h, `Custom ${h}`])];
  const chosen = normHex(custom);
  // Readability: text on a white page, or dark text on the highlight.
  const warning = chosen && (kind === 'text'
    ? (contrast(chosen, '#ffffff') < 3 ? 'Light colours are hard to read on a white page.' : '')
    : (contrast('#1f1f1f', chosen) < 4.5 ? 'Dark highlights make the text on them hard to read.' : ''));
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    const i = Math.max(0, options.findIndex(([v]) => (v ? sameColor(current, v) : !current)));
    keepOnScreen(list.current?.closest('.color-pop'));
    list.current?.querySelectorAll('button')[i]?.focus();
    setRecent(loadRecent(kind));
    setCustom(current ? toHex(current) : '');
    return () => document.removeEventListener('mousedown', away);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pick = (v) => { setOpen(false); refocus?.(); onPick(v); };
  const applyCustom = () => { if (!chosen) return; saveRecent(kind, chosen, colors); pick(chosen); };
  const onKey = (e) => {
    escCloses(open, setOpen, wrap)(e);
    if (!open || e.defaultPrevented) return;
    const buttons = [...(list.current?.querySelectorAll('button') || [])];
    let i = buttons.indexOf(document.activeElement);
    if (i < 0) {
      if (document.activeElement !== wrap.current?.querySelector('button')) return; // typing in the custom colour box
      i = Math.max(0, options.findIndex(([v]) => (v ? sameColor(current, v) : !current))); // still on the toolbar button
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -99, End: 99 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, i + step))].focus();
  };
  return (
    <span className="color-picker" ref={wrap} onKeyDown={onKey}>
      <button type="button" className={`tb ${open ? 'on' : ''}`} title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} onKeyDown={keyOpens(open, setOpen)}>
        {icon(current)}
      </button>
      {open && (
        <div className="color-pop" role="dialog" aria-label={label}>
          <div className="color-list" ref={list} role="listbox" aria-label="Colours">
            {options.map(([v, name]) => {
              const on = v ? sameColor(current, v) : !current;
              return (
                <button type="button" key={name} role="option" aria-selected={on} aria-label={name} title={name}
                  className={`swatch ${v ? '' : 'auto'} ${on ? 'on' : ''}`} style={v ? { background: v } : undefined}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => pick(v)} />
              );
            })}
          </div>
          <div className="color-custom" role="group" aria-label="Custom colour">
            <input type="color" aria-label="Choose a custom colour" value={chosen || (kind === 'text' ? '#1f1f1f' : '#fef08a')}
              onChange={(e) => setCustom(e.target.value)} />
            <input type="text" aria-label="Colour code" placeholder="#1a73e8" maxLength={7} spellCheck={false} value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyCustom(); } }} />
            <button type="button" className="btn small" disabled={!chosen} onClick={applyCustom}>Apply</button>
          </div>
          {custom && (
            <div className="color-sample" aria-live="polite">
              {chosen
                ? <span style={kind === 'text' ? { color: chosen } : { background: chosen, color: '#1f1f1f' }}>Sample text</span>
                : <span className="muted">Enter a colour code like #1a73e8</span>}
              {warning && <div className="color-warn">{warning}</div>}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

const PICK_MAX = 8;

/**
 * "Insert table": a grid to choose the size (hover, or arrow keys and Enter), with a header row
 * option. Not offered inside a table, so tables aren't nested.
 */
function TablePicker({ onPick, disabled, refocus }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState([2, 3]); // [rows, cols] highlighted
  const [header, setHeader] = useState(true);
  const wrap = useRef();
  const grid = useRef();
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    keepOnScreen(grid.current?.closest('.table-picker-pop'));
    grid.current?.querySelector('[tabindex="0"]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // Close first, then insert, so the cursor lands in the new table's first cell.
  const pick = (r, c) => { setOpen(false); refocus?.(); requestAnimationFrame(() => onPick(r, c, header)); };
  const onKey = (e) => {
    escCloses(open, setOpen, wrap)(e);
    if (!open || e.defaultPrevented) return;
    const [r, c] = at;
    const next = { ArrowRight: [r, c + 1], ArrowLeft: [r, c - 1], ArrowDown: [r + 1, c], ArrowUp: [r - 1, c] }[e.key];
    // Enter/Space insert the highlighted size (not whichever cell the browser would click).
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[role="grid"]')) { e.preventDefault(); pick(r, c); return; }
    if (!next) return;
    e.preventDefault();
    const n = next.map((v) => Math.max(1, Math.min(PICK_MAX, v)));
    setAt(n);
    grid.current?.querySelector(`[data-cell="${n[0]}-${n[1]}"]`)?.focus(); // every cell is already rendered
  };
  return (
    <span className="table-picker" ref={wrap} onKeyDown={onKey}>
      <button type="button" className={`tb ${open ? 'on' : ''}`} title={disabled ? 'Insert table (not inside another table)' : 'Insert table'} aria-label="Insert table"
        aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((o) => !o)} onKeyDown={keyOpens(open, setOpen)}>▦</button>
      {open && (
        <div className="table-picker-pop" role="dialog" aria-label="Table size">
          <div className="table-picker-grid" ref={grid} role="grid" aria-label="Choose rows and columns">
            {Array.from({ length: PICK_MAX }, (_, i) => (
              <div role="row" key={i}>
                {Array.from({ length: PICK_MAX }, (_, j) => {
                  const r = i + 1, c = j + 1;
                  return (
                    <button type="button" role="gridcell" key={j} data-cell={`${r}-${c}`} tabIndex={r === at[0] && c === at[1] ? 0 : -1}
                      className={r <= at[0] && c <= at[1] ? 'on' : ''} aria-label={`${r} by ${c} table`}
                      onMouseDown={(e) => e.preventDefault()} onMouseEnter={(e) => e.currentTarget.focus()} onFocus={() => setAt([r, c])} onClick={() => pick(r, c)} />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="table-picker-foot">
            <span aria-live="polite">{at[0]} × {at[1]}</span>
            <label className="check"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Header row</label>
          </div>
        </div>
      )}
    </span>
  );
}

/** Insert or change a link: the text shown, and a web or email address. */
function LinkDialog({ initial, onApply, onRemove, onClose }) {
  const startEmail = /^mailto:/i.test(initial.href);
  const [text, setText] = useState(initial.text);
  const [kind, setKind] = useState(startEmail ? 'email' : 'web');
  const [address, setAddress] = useState(startEmail ? initial.href.replace(/^mailto:/i, '') : initial.href);
  const href = linkHref(kind, address);
  const bad = address.trim() && !href;
  // stopPropagation: this dialog is opened from inside the message form, which must not see the submit.
  const submit = (e) => { e.preventDefault(); e.stopPropagation(); if (href) onApply({ text: text.trim() ? text : (initial.text || address.trim()), href }); };
  return (
    <Modal title={initial.href ? 'Edit link' : 'Insert link'} onClose={onClose} footer={<>
      {onRemove && <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={onRemove}>Remove link</button>}
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="submit" form="link-form" className="btn primary" disabled={!href}>{initial.href ? 'Save' : 'Insert'}</button>
    </>}>
      <form id="link-form" className="stack" onSubmit={submit}>
        <label className="field"><span>Text to display</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave empty to show the address" autoFocus={!initial.text} /></label>
        <div className="row" role="radiogroup" aria-label="Link to">
          <label className="check"><input type="radio" name="link-kind" checked={kind === 'web'} onChange={() => setKind('web')} /> Web address</label>
          <label className="check"><input type="radio" name="link-kind" checked={kind === 'email'} onChange={() => setKind('email')} /> Email address</label>
        </div>
        <label className="field"><span>{kind === 'web' ? 'Web address' : 'Email address'}</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} autoFocus={!!initial.text} inputMode={kind === 'email' ? 'email' : 'url'}
            placeholder={kind === 'web' ? 'example.com/page' : 'name@company.com'} aria-invalid={bad || undefined} aria-describedby="link-help" spellCheck={false} /></label>
        <p id="link-help" className={`small ${bad ? 'error' : 'muted'}`} aria-live="polite">
          {bad ? (kind === 'web' ? 'Enter a web address, like example.com or https://example.com/page.' : 'Enter an email address, like name@company.com.')
            : href && kind === 'web' ? <a href={href} target="_blank" rel="noopener noreferrer">Test this link</a> : '\u00a0'}
        </p>
      </form>
    </Modal>
  );
}

const editablePicture = (src) => /^\/api\/files\/[^/]+\/raw$|^\/api\/mail\/messages\/\d+\/pictures\/\d+\?folder=[^&]+$/.test(src || '');
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const ASPECT_NAMES = { free: 'Free', square: 'Square', '4:3': '4:3', '16:9': '16:9' };

/**
 * Crop and rotate a picture. Works on the real pixels: the result is saved to Drive as
 * "name (edited).jpg/png" and replaces the picture in the message.
 */
function ImageEditor({ src, alt, onClose, onDone }) {
  const toast = useToast();
  const [source, setSource] = useState(null); // { img, mime }
  const [error, setError] = useState('');
  const [rot, setRot] = useState(0);
  const [aspect, setAspect] = useState('free');
  const [rect, setRect] = useState(FULL);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef();
  const stageRef = useRef();

  useEffect(() => {
    let url = null, gone = false;
    (async () => {
      try {
        const res = await fetch(src, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Could not load the picture');
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        const img = new window.Image();
        img.src = url;
        await img.decode();
        if (!gone) setSource({ img, mime: blob.type });
      } catch (e) { if (!gone) setError(e.message || 'Could not load the picture'); }
    })();
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [src]);

  const size = source ? rotatedSize(source.img.naturalWidth, source.img.naturalHeight, rot) : { w: 1, h: 1 };

  // Draw the rotated picture at full resolution; the preview is the same canvas scaled down by CSS.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!source || !cv) return;
    drawRotated(cv, source.img, rot);
  }, [source, rot]);

  const rotate = (by) => {
    const next = (rot + by + 360) % 360;
    setRot(next);
    const s = rotatedSize(source.img.naturalWidth, source.img.naturalHeight, next);
    setRect(fitAspect(ASPECTS[aspect], s.w, s.h));
  };
  const chooseAspect = (a) => { setAspect(a); setRect(fitAspect(ASPECTS[a], size.w, size.h)); };

  // Drag the frame to move it, or a handle to resize it. Movements are converted to fractions of the preview.
  const startDrag = (e, handle) => {
    e.preventDefault();
    e.stopPropagation();
    const box = stageRef.current.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, r: rect };
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - start.x) / box.width, dy = (ev.clientY - start.y) / box.height;
      setRect(handle ? resizeRect(start.r, handle, dx, dy, ASPECTS[aspect], size.w, size.h) : moveRect(start.r, dx, dy));
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  // Arrows move the frame; Shift+arrows resize it from the bottom-right corner.
  const onKey = (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const [dx, dy] = d.map((v) => v * 0.01);
    setRect((r) => (e.shiftKey ? resizeRect(r, 'se', dx, dy, ASPECTS[aspect], size.w, size.h) : moveRect(r, dx, dy)));
  };

  const changed = rot !== 0 || rect.x > 1e-6 || rect.y > 1e-6 || rect.w < 1 - 1e-6 || rect.h < 1 - 1e-6;
  const pixels = source ? toPixels(rect, size.w, size.h) : null;

  async function apply() {
    if (!changed) return onClose();
    setBusy(true);
    try {
      const full = document.createElement('canvas');
      drawRotated(full, source.img, rot);
      const out = document.createElement('canvas');
      out.width = pixels.sw;
      out.height = pixels.sh;
      const ctx = out.getContext('2d');
      const kind = outputType(source.mime);
      if (kind.type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height); } // JPEG has no transparency
      ctx.drawImage(full, pixels.sx, pixels.sy, pixels.sw, pixels.sh, 0, 0, pixels.sw, pixels.sh);
      const blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the picture'))), kind.type, kind.quality));
      const rec = await uploadFile(new File([blob], editedName(alt, kind.ext), { type: kind.type }), null);
      onDone({ src: `/api/files/${rec.id}/raw`, alt: rec.name });
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  }

  const pct = (v) => `${v * 100}%`;
  return (
    <Modal title="Crop and rotate picture" wide onClose={busy ? () => {} : onClose} footer={<>
      {pixels && <span className="muted small crop-size" aria-live="polite">{pixels.sw} × {pixels.sh} px</span>}
      <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="btn primary" onClick={apply} disabled={!source || busy}>{busy ? 'Saving…' : 'Apply'}</button>
    </>}>
      {error ? <p className="error">{error}</p> : !source ? <p className="muted">Loading picture…</p> : (
        <>
          <div className="toolbar crop-tools" role="toolbar" aria-label="Picture tools">
            <button type="button" className="btn" onClick={() => rotate(-90)} aria-label="Rotate left">⟲ Rotate left</button>
            <button type="button" className="btn" onClick={() => rotate(90)} aria-label="Rotate right">⟳ Rotate right</button>
            <span className="sep" />
            <span role="group" aria-label="Crop shape" className="crop-aspects">
              {Object.keys(ASPECTS).map((a) => (
                <button type="button" key={a} className={`btn ${aspect === a ? 'on' : ''}`} aria-pressed={aspect === a} onClick={() => chooseAspect(a)}>{ASPECT_NAMES[a]}</button>
              ))}
            </span>
            <button type="button" className="btn" onClick={() => setRect(fitAspect(ASPECTS[aspect], size.w, size.h))}>Reset crop</button>
          </div>
          <div className="crop-area">
            <div className="crop-stage" ref={stageRef}>
              <canvas ref={canvasRef} aria-label="Picture preview" role="img" />
              <div className="crop-frame" tabIndex={0} role="group" aria-label="Crop area. Use the arrow keys to move it, Shift and the arrow keys to resize it."
                style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
                onPointerDown={(e) => startDrag(e, null)} onKeyDown={onKey}>
                {HANDLES.map((h) => <span key={h} className={`crop-handle ${h}`} data-handle={h} onPointerDown={(e) => startDrag(e, h)} />)}
              </div>
            </div>
          </div>
          <p className="muted small">Drag the frame or its edges. Applying saves a new copy to your Drive; the original stays as it was, and Ctrl+Z in the message puts it back.</p>
        </>
      )}
    </Modal>
  );
}

/** Draw img into canvas cv rotated by deg (multiple of 90), resizing the canvas to fit. */
function drawRotated(cv, img, deg) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const s = rotatedSize(W, H, deg);
  cv.width = s.w;
  cv.height = s.h;
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.translate(s.w / 2, s.h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -W / 2, -H / 2);
  ctx.restore();
}

function SignatureDialog({ signatures, onClose, onSaved }) {
  const toast = useToast();
  const [address, setAddress] = useState(signatures[0]?.address);
  const current = signatures.find((x) => x.address === address) || { html: '', on_new: true, on_reply: true };
  const [html, setHtml] = useState(current.html);
  const [onNew, setOnNew] = useState(current.on_new);
  const [onReply, setOnReply] = useState(current.on_reply);
  const pick = (a) => {
    const sg = signatures.find((x) => x.address === a);
    setAddress(a); setHtml(sg.html); setOnNew(sg.on_new); setOnReply(sg.on_reply);
  };
  return (
    <Modal wide title="Signatures" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        if (e.target !== e.currentTarget) return; // a dialog opened from inside (see Compose's send)
        try {
          const r = await put(`/mail/signatures/${encodeURIComponent(address)}`, { html, on_new: onNew, on_reply: onReply });
          toast(`Signature for ${address} saved`);
          onSaved(signatures.map((x) => (x.address === address ? r : x)));
        } catch (err) { toast(err.message, 'error'); }
      }}>
        {signatures.length > 1 && (
          <div className="tabs" role="tablist" aria-label="Sending address">
            {signatures.map((x) => (
              <button type="button" key={x.address} role="tab" aria-selected={x.address === address} className={x.address === address ? 'on' : ''} onClick={() => pick(x.address)}>{x.address}</button>
            ))}
          </div>
        )}
        <RichBody key={address} initialHtml={current.html} label="Signature" placeholder="Your name, title, company, phone…" onChange={(h) => setHtml(h)} />
        <label className="check"><input type="checkbox" checked={onNew} onChange={(e) => setOnNew(e.target.checked)} /> Add to new messages</label>
        <label className="check"><input type="checkbox" checked={onReply} onChange={(e) => setOnReply(e.target.checked)} /> Add to replies and forwards (above the quoted message)</label>
        <p className="muted small" style={{ margin: 0 }}>Each address you can send from has its own signature. Changing “From” while writing switches the signature.</p>
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Close</button><button className="btn primary">Save</button></div>
      </form>
    </Modal>
  );
}

/** The signature lives in its own block so switching "From" can find and replace it. */
const SignatureBlock = TiptapNode.create({
  name: 'signature',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML() { return [{ tag: 'div[data-signature]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-signature': '', class: 'signature' }), 0]; },
});

function signatureBlock(signatures, address, kind) {
  const sg = signatures.find((x) => x.address === address);
  if (!sg?.html || (kind === 'new' ? !sg.on_new : !sg.on_reply)) return '';
  return `<div data-signature=""><p>-- </p>${sg.html}</div>`;
}

/** Replace the signature block (or add one: at the end of a new message, below the first line of a reply). */
function swapSignature(editor, html) {
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'signature') { found = { from: pos, to: pos + node.nodeSize }; return false; }
    return true;
  });
  if (found) {
    if (html) editor.chain().insertContentAt(found, html).run();
    else editor.chain().deleteRange(found).run();
  } else if (html) {
    const first = editor.state.doc.firstChild;
    const isReply = editor.getHTML().includes('<blockquote');
    editor.chain().insertContentAt(isReply && first ? first.nodeSize : editor.state.doc.content.size, html).run();
  }
}

/** Picture sizes as a share of the message width; stored on the picture so mail apps show the same size. */
const IMAGE_SIZES = [[25, 'Small'], [50, 'Medium'], [75, 'Large'], [100, 'Full width']];
const MIN_WIDTH = 10;
const SNAP = [25, 50, 75, 100];
const clampWidth = (v) => Math.max(MIN_WIDTH, Math.min(100, Math.round(v)));

/**
 * Pictures with a size as a share of the message width (10-100%), stored on the picture so mail
 * apps show the same size. In the editor a selected picture gets a corner handle: drag it (snaps
 * to 25/50/75/100% when close), or focus it and use the arrow keys (Shift for 1% steps).
 */
const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const v = Number(el.getAttribute('data-width') || String(el.style?.width || '').replace('%', ''));
          return Number.isFinite(v) && v >= MIN_WIDTH && v < 100 ? Math.round(v) : null;
        },
        // The width attribute plus inline style work across Gmail, Outlook and phone mail apps;
        // max-width keeps pictures inside narrow screens.
        renderHTML: (attrs) => (attrs.width
          ? { 'data-width': attrs.width, width: `${attrs.width}%`, style: `width:${attrs.width}%; max-width:100%; height:auto` }
          : { style: 'max-width:100%; height:auto' }),
      },
      // Centred or right-aligned picture (left is normal). Margins in the message; the email also
      // wraps it in an aligned block for Outlook (see emailHtml).
      align: {
        default: null,
        parseHTML: (el) => (['center', 'right'].includes(el.getAttribute('data-align')) ? el.getAttribute('data-align') : null),
        renderHTML: (attrs) => (attrs.align === 'center' ? { 'data-align': 'center', style: 'display:block; margin-left:auto; margin-right:auto' }
          : attrs.align === 'right' ? { 'data-align': 'right', style: 'display:block; margin-left:auto' } : {}),
      },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'img-wrap';
      const img = document.createElement('img');
      const handle = document.createElement('span');
      handle.className = 'img-handle';
      handle.tabIndex = 0;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-label', 'Picture width');
      handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
      handle.setAttribute('aria-valuemax', '100');
      const label = document.createElement('span');
      label.className = 'img-size-label';
      dom.append(img, handle, label);

      // pct = null: no size chosen, so the picture shows at its natural size (never wider than the message).
      const show = (pct) => {
        dom.style.width = pct ? `${pct}%` : '';
        dom.classList.toggle('natural', !pct);
        const now = pct || shownPct();
        handle.setAttribute('aria-valuenow', String(now));
        handle.setAttribute('aria-valuetext', `${now}% of the message width`);
        label.textContent = `${now}%`;
      };
      const shownPct = () => {
        const full = contentWidth();
        return full > 0 ? clampWidth((dom.getBoundingClientRect().width / full) * 100) : 100;
      };
      const render = (n) => {
        img.src = n.attrs.src;
        img.alt = n.attrs.alt || '';
        if (n.attrs.width) dom.setAttribute('data-width', String(n.attrs.width)); else dom.removeAttribute('data-width');
        if (n.attrs.align) dom.setAttribute('data-align', n.attrs.align); else dom.removeAttribute('data-align');
        show(n.attrs.width || null);
      };
      img.addEventListener('load', () => { if (!current.attrs.width) show(null); }); // natural size known now
      img.addEventListener('dblclick', (e) => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        e.preventDefault();
        editor.commands.setNodeSelection(pos);
        editor.emit('editPicture');
      });
      const commit = (pct) => {
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos == null) return;
        const width = pct >= 100 ? null : pct;
        if ((current.attrs.width || null) === width) return show(width);
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, width }));
      };
      const contentWidth = () => {
        // While the editor is still being set up (a draft or forward that opens with a picture),
        // there is nothing to measure yet; the picture's load event measures again.
        let el;
        try { el = editor.view.dom; } catch { return 0; }
        if (!el?.isConnected) return 0;
        const cs = getComputedStyle(el);
        return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      };

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        dom.classList.add('resizing');
        const startX = e.clientX;
        const startW = dom.getBoundingClientRect().width;
        const full = contentWidth();
        let pct = current.attrs.width || shownPct();
        const move = (ev) => {
          pct = clampWidth(((startW + ev.clientX - startX) / full) * 100);
          const near = SNAP.find((s) => Math.abs(s - pct) <= 2);
          if (near) pct = near;
          show(pct);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          dom.classList.remove('resizing');
          commit(pct);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
      handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 1 : 5;
        const now = current.attrs.width || shownPct();
        const next = { ArrowLeft: now - step, ArrowDown: now - step, ArrowRight: now + step, ArrowUp: now + step, Home: MIN_WIDTH, End: 100 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        commit(clampWidth(next));
      });

      render(node);
      return {
        dom,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          render(n);
          return true;
        },
        selectNode() { dom.classList.add('ProseMirror-selectednode'); },
        deselectNode() { dom.classList.remove('ProseMirror-selectednode'); },
        // Let the handle have its own mouse/keyboard events instead of the editor.
        stopEvent: (e) => e.target === handle,
        ignoreMutation: () => true,
      };
    };
  },
});
