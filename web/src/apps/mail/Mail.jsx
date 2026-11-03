import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, post, uploadFile, formatBytes, formatDate } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, Empty, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';

const FOLDER_ICON = { '\\Inbox': 'inbox', '\\Drafts': 'doc', '\\Sent': 'send', '\\Archive': 'archive', '\\Junk': 'report', '\\Trash': 'trash' };
const enc = encodeURIComponent;
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

  const loadFolders = useCallback(() => get('/mail/folders').then(setFolders).catch((e) => setError(e.message)), []);
  const loadList = useCallback(() => get(`/mail/messages?folder=${enc(folder)}&page=${page}${q ? `&q=${enc(q)}` : ''}`)
    .then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)), [folder, page, q]);

  useEffect(() => { setData(null); setChecked(new Set()); loadList(); }, [loadList]);
  useEffect(() => { loadFolders(); }, [loadFolders]);
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

  const sel = [...checked];
  return (
    <div className={`mail ${openUid ? 'reading' : ''}`}>
      <aside className="subnav">
        <button className="btn new-btn" onClick={() => setCompose({})}><Icon name="edit" /> Compose</button>
        {folders.map((f) => (
          <button key={f.path} className={`subnav-item ${f.path === folder && !q ? 'active' : ''}`} onClick={() => { setSearch({}); go(f.path); }}>
            <Icon name={FOLDER_ICON[f.specialUse] || 'folder'} /><span className="grow ellipsis">{f.name}</span>
            {f.unseen > 0 && f.specialUse !== '\\Trash' && f.specialUse !== '\\Sent' && <span className="count">{f.unseen}</span>}
          </button>
        ))}
      </aside>

      <section className="mail-list">
        <div className="mail-toolbar">
          <form className="mail-search" role="search" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('q').trim(); setSearch(v ? { q: v } : {}); }}>
            <Icon name="search" size={18} />
            <input name="q" defaultValue={q} key={q} placeholder={`Search ${current?.name || 'mail'}`} aria-label="Search mail" />
          </form>
          <button className="icon-btn" aria-label="Refresh" onClick={refresh}><Icon name="restore" size={20} /></button>
        </div>
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
                <button className="msg-row" onClick={() => go(folder, m.uid)}>
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
            onClose={() => go(folder)} onChanged={refresh} act={act} onCompose={setCompose} />
        ) : <Empty icon="mail" title="No message selected" />}
      </section>

      {compose && <Compose initial={compose} onClose={() => setCompose(null)} onSent={() => { setCompose(null); refresh(); }} />}
    </div>
  );
}

function Reader({ folder, uid, special, onClose, onChanged, act, onCompose }) {
  const toast = useToast();
  const { user } = useAuth();
  const [m, setM] = useState(null);
  const [images, setImages] = useState(false);
  useEffect(() => {
    get(`/mail/messages/${uid}?folder=${enc(folder)}`).then((x) => { setM(x); onChanged(); }).catch((e) => { toast(e.message, 'error'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, uid]);
  if (!m) return <p className="muted mail-note">Loading…</p>;

  const quoted = () => `\n\nOn ${new Date(m.date).toLocaleString()}, ${who(m.from)} wrote:\n${(m.text || '').split('\n').map((l) => `> ${l}`).join('\n')}`;
  const reSubject = (p) => (m.subject.toLowerCase().startsWith(p.toLowerCase()) ? m.subject : `${p} ${m.subject}`);
  const thread = { inReplyTo: m.messageId, references: m.references, replyTo: { folder, uid } };
  const replyTo = m.replyTo.length ? m.replyTo : m.from ? [m.from] : [];
  const others = [...m.to, ...m.cc].filter((a) => a.address !== user.username && !replyTo.some((r) => r.address === a.address));
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
        <button className="btn" onClick={() => onCompose({ to: list(replyTo), subject: reSubject('Re:'), text: quoted(), ...thread })}><Icon name="reply" size={18} /> Reply</button>
        {others.length > 0 && <button className="btn" onClick={() => onCompose({ to: list(replyTo), cc: list(others), subject: reSubject('Re:'), text: quoted(), ...thread })}><Icon name="replyall" size={18} /> Reply all</button>}
        <button className="btn" onClick={() => onCompose({
          subject: reSubject('Fwd:'),
          text: `\n\n---------- Forwarded message ----------\nFrom: ${list([m.from])}\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\nTo: ${list(m.to)}\n\n${m.text || ''}`,
        })}><Icon name="forward" size={18} /> Forward</button>
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

function Compose({ initial, onClose, onSent }) {
  const toast = useToast();
  const { user } = useAuth();
  const [identities, setIdentities] = useState([{ address: user.username }]);
  const [f, setF] = useState({ from: user.username, to: '', cc: '', bcc: '', subject: '', text: '', ...initial });
  const [showCc, setShowCc] = useState(!!(initial.cc || initial.bcc));
  const [files, setFiles] = useState([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { get('/mail/status').then((s) => setIdentities(s.identities)).catch(() => {}); }, []);

  async function send(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post('/mail/send', { ...f, attachments: files.map((x) => x.id) });
      toast(`Sent to ${r.recipients} recipient${r.recipients === 1 ? '' : 's'}`);
      onSent();
    } catch (err) { toast(err.message, 'error'); setBusy(false); }
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
    <Modal wide title={initial.subject ? initial.subject : 'New message'} onClose={() => !busy && onClose()}>
      <form className="compose stack" onSubmit={send}>
        {identities.length > 1 && (
          <label className="compose-line"><span>From</span>
            <select aria-label="From" value={f.from} onChange={set('from')}>{identities.map((i) => <option key={i.address} value={i.address}>{i.address}</option>)}</select>
          </label>
        )}
        <label className="compose-line"><span>To</span><input aria-label="To" autoFocus={!initial.to} type="text" inputMode="email" value={f.to} onChange={set('to')} placeholder="name@company.com, …" />
          {!showCc && <button type="button" className="link" onClick={() => setShowCc(true)}>Cc/Bcc</button>}</label>
        {showCc && <>
          <label className="compose-line"><span>Cc</span><input aria-label="Cc" type="text" inputMode="email" value={f.cc} onChange={set('cc')} /></label>
          <label className="compose-line"><span>Bcc</span><input aria-label="Bcc" type="text" inputMode="email" value={f.bcc} onChange={set('bcc')} /></label>
        </>}
        <label className="compose-line"><span>Subject</span><input aria-label="Subject" value={f.subject} onChange={set('subject')} /></label>
        <textarea className="compose-body" aria-label="Message" rows={14} value={f.text} onChange={set('text')} autoFocus={!!initial.to}
          ref={(el) => { if (el && initial.to && !el.dataset.placed) { el.dataset.placed = '1'; el.setSelectionRange(0, 0); el.scrollTop = 0; } }} />
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
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
          <div className="grow" />
          <button type="button" className="icon-btn" aria-label="Discard" title="Discard" onClick={onClose}><Icon name="trash" /></button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Files you attach from your computer are also saved to your Drive.</p>
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
