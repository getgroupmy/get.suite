// The page someone without an account sees when they open a share link: /s/<token>.
import { lazy, Suspense, useEffect, useState } from 'react';
import { formatBytes, formatDate } from '../api.js';
import Icon, { fileIcon } from '../components/Icon.jsx';
import CodeContents from './CodeContents.jsx';
import TableContents from './TableContents.jsx';
import { CardsList } from './CardFileContents.jsx';
import { previewKind } from '../components/viewkind.js';

const LinkedItem = lazy(() => import('./LinkedItem.jsx'));
const OPENABLE = ['doc', 'sheet', 'slides'];
const KIND_NAME = { doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation' };
const OFFICE = { doc: 'Word', sheet: 'Excel', slides: 'PowerPoint' };
const keyName = (token) => `nw.link.${token}`;
const readKey = (token) => { try { return sessionStorage.getItem(keyName(token)) || ''; } catch { return ''; } };
const saveKey = (token, key) => { try { sessionStorage.setItem(keyName(token), key); } catch {} };

async function call(method, url, key, body) {
  const res = await fetch(`/api/public/links${url}`, {
    method,
    headers: { 'x-requested-with': 'nas-workspace', ...(key && { 'x-link-key': key }), ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

export default function PublicLink({ token }) {
  const [key, setKey] = useState(() => readKey(token));
  const [folder, setFolder] = useState(null); // a folder inside a linked folder
  const [open, setOpen] = useState(null);     // a file inside a linked folder, being viewed
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    call('GET', `/${encodeURIComponent(token)}${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`, key)
      .then((i) => { if (live) { setInfo(i); setError(null); } })
      .catch((e) => live && setError(e));
    return () => { live = false; };
  }, [token, key, folder]);

  useEffect(() => { if (info?.name) document.title = info.name; }, [info?.name]);

  const raw = (item, download) => {
    const qs = new URLSearchParams({ ...(item && { item }), ...(key && { key }) }).toString();
    return `/api/public/links/${encodeURIComponent(token)}/raw${qs ? `?${qs}` : ''}${download ? `${qs ? '&' : '?'}download` : ''}`;
  };

  let body;
  if (error) body = <div className="link-msg" role="alert"><Icon name="link" size={40} /><h1>{error.status === 410 ? 'Link expired' : 'Link not available'}</h1><p className="muted">{error.message}</p></div>;
  else if (!info) body = <p className="muted">Loading…</p>;
  else if (info.locked) body = <Unlock token={token} info={info} onKey={(k) => { saveKey(token, k); setKey(k); }} />;
  else if (info.mode === 'upload') body = <FileRequest token={token} info={info} linkKey={key} />;
  else if (info.kind === 'file') body = <FileView file={info} src={raw()} download={raw(null, true)} read={(what) => call('GET', `/${encodeURIComponent(token)}/${what}`, key)} />;
  else if (OPENABLE.includes(info.kind)) body = <ItemView token={token} linkKey={key} item={{ id: info.root, name: info.name, kind: info.kind, updated_at: info.updated_at, no_download: info.no_download }} download={raw(null, true)} />;
  else if (open) body = (
    <>
      <button type="button" className="link-btn" onClick={() => setOpen(null)}><Icon name="back" size={18} /> Back to {info.path.at(-1).name}</button>
      {OPENABLE.includes(open.kind)
        ? <ItemView token={token} linkKey={key} item={open} download={raw(open.id, true)} />
        : <FileView file={open} src={raw(open.id)} download={raw(open.id, true)} read={(what) => call('GET', `/${encodeURIComponent(token)}/${what}${what.includes('?') ? '&' : '?'}item=${encodeURIComponent(open.id)}`, key)} />}
    </>
  );
  else {
    const qs = new URLSearchParams({ ...(folder && { folder }), ...(key && { key }) }).toString();
    body = <FolderView info={info} onFolder={(id) => setFolder(id === info.root ? null : id)} onOpen={setOpen} download={(id) => raw(id, true)} zip={`/api/public/links/${encodeURIComponent(token)}/zip${qs ? `?${qs}` : ''}`} />;
  }

  return (
    <div className="link-page">
      <header className="link-head">
        <div className="brand"><span className="brand-mark">W</span><span className="brand-text">Workspace</span></div>
        {info && !error && <span className="muted small">{info.mode === 'upload' ? 'Requested by' : 'Shared by'} {info.owner_name} · {info.org_name}</span>}
      </header>
      <main className="link-main">{body}</main>
      {info?.expires_at && !error && <p className="muted small link-foot">This link works until {formatDate(info.expires_at)}.</p>}
    </div>
  );
}

function Unlock({ token, info, onKey }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { onKey((await call('POST', `/${encodeURIComponent(token)}/unlock`, '', { password })).key); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form className="link-unlock stack" onSubmit={submit}>
      <Icon name="lock" size={40} />
      <h1>{info.name}</h1>
      <p className="muted">{info.owner_name} protected this {info.kind === 'folder' ? 'folder' : 'file'} with a password.</p>
      <label className="field"><span>Password</span>
        <input type="password" value={password} autoFocus autoComplete="off" onChange={(e) => { setPassword(e.target.value); setError(''); }} /></label>
      {error && <p className="error small" role="alert">{error}</p>}
      <button className="btn primary" disabled={!password || busy}>Open</button>
    </form>
  );
}

function FileView({ file, src, download, read }) {
  const m = file.mime || '';
  let preview = null;
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(m)) preview = <img src={src} alt={file.name} className="preview-media" />;
  else if (/^video\/(mp4|webm)$/.test(m)) preview = <video src={src} controls className="preview-media" />;
  else if (m.startsWith('audio/')) preview = <audio src={src} controls />;
  else if (/\.(md|markdown)$/i.test(file.name)) preview = <LinkMarkdown read={read} />;
  else if (previewKind(file.name) === 'table') preview = <TableContents name={file.name} load={() => read('source-text')} />;
  else if (m === 'application/pdf' || /^text\/(plain|csv|markdown)$/.test(m)) preview = <iframe src={src} title={file.name} className="preview-frame" />;
  else if (previewKind(file.name) === 'code') preview = <CodeContents name={file.name} load={() => read('source-text')} />;
  else if (/\.(ics|vcf)$/i.test(file.name)) preview = <LinkCards read={read} canDownload={!file.no_download} />;
  return (
    <section className="link-file stack">
      <div className="row link-file-head">
        <Icon name={fileIcon(file)} size={32} />
        <div className="grow"><h1 className="ellipsis">{file.name}</h1><p className="muted small">{formatBytes(file.size)} · modified {formatDate(file.updated_at)}</p></div>
        {file.no_download ? <span className="muted small">View only: downloading is turned off</span> : <a className="btn primary" href={download}><Icon name="download" size={18} /> Download</a>}
      </div>
      {preview ? <div className="preview">{preview}</div> : <p className="muted">No preview for this kind of file. Download it to open it on your device.</p>}
    </section>
  );
}

/** A document, spreadsheet or presentation inside the linked folder: read-only, with Download as an Office file. */
function ItemView({ token, linkKey, item, download }) {
  const [got, setGot] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    call('GET', `/${encodeURIComponent(token)}/content?item=${encodeURIComponent(item.id)}`, linkKey).then((x) => live && setGot(x)).catch((e) => live && setError(e));
    return () => { live = false; };
  }, [token, linkKey, item.id]);
  const base = `/api/public/links/${encodeURIComponent(token)}/items/${encodeURIComponent(item.id)}/${encodeURIComponent(linkKey || '-')}`;
  return (
    <section className="link-file stack">
      <div className="row link-file-head">
        <Icon name={fileIcon(item)} size={32} />
        <div className="grow"><h1 className="ellipsis">{item.name}</h1><p className="muted small">{KIND_NAME[item.kind]} · modified {formatDate(item.updated_at)}</p></div>
        {!item.no_download && <a className="btn primary" href={download}><Icon name="download" size={18} /> Download as {OFFICE[item.kind]}</a>}
      </div>
      {error ? <p className="error" role="alert">{error.message}</p> : !got ? <p className="muted">Loading…</p>
        : <Suspense fallback={<p className="muted">Loading…</p>}><LinkedItem item={got} base={base} /></Suspense>}
    </section>
  );
}

function FolderView({ info, onFolder, onOpen, download, zip }) {
  return (
    <section className="link-folder stack">
      <nav className="crumbs" aria-label="Folder path">
        {info.path.map((p, i) => i < info.path.length - 1
          ? <span key={p.id}><button type="button" className="link-btn" onClick={() => onFolder(p.id)}>{p.name}</button> / </span>
          : <h1 key={p.id}>{p.name}</h1>)}
      </nav>
      {info.items.length > 0 && <div className="row end"><a className="btn" href={zip} title="Everything in this folder as one .zip: documents as Word, spreadsheets as Excel, presentations as PowerPoint"><Icon name="download" size={18} /> Download all (.zip)</a></div>}
      {info.items.length === 0 ? <p className="muted">This folder is empty.</p> : (
        <ul className="link-items">
          {info.items.map((f) => (
            <li key={f.id}>
              <Icon name={fileIcon(f)} size={22} />
              <button type="button" className="link-btn grow ellipsis" onClick={() => (f.kind === 'folder' ? onFolder(f.id) : onOpen(f))}>{f.name}</button>
              {f.kind === 'file' && <><span className="muted small">{formatBytes(f.size)}</span>
                <a className="icon-btn" href={download(f.id)} aria-label={`Download ${f.name}`}><Icon name="download" size={18} /></a></>}
              {OPENABLE.includes(f.kind) && <><span className="muted small">{KIND_NAME[f.kind]}</span>
                {!f.no_download && <a className="icon-btn" href={download(f.id)} aria-label={`Download ${f.name} as ${OFFICE[f.kind]}`}><Icon name="download" size={18} /></a>}</>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Why a file can't go through this request (its kind or size), as the server would say it, or null. */
export function notTaken(file, info) {
  const exts = (info.accept_attr || '').split(',').filter(Boolean);
  const ext = (/\.[a-z0-9]{1,8}$/i.exec(file.name)?.[0] || '').toLowerCase();
  if (exts.length && !exts.includes(ext)) return `${file.name} can't be sent here: this request only takes ${info.accept_text}`;
  if (info.max_mb && file.size > info.max_mb * 1024 * 1024) return `${file.name} is too large: files can be at most ${info.max_mb} MB here`;
  return null;
}

/** A file request: send files into someone's folder. You see only what you sent from this page. */
function FileRequest({ token, info, linkKey }) {
  const [from, setFrom] = useState(() => { try { return localStorage.getItem('nw.requestFrom') || ''; } catch { return ''; } });
  const [sent, setSent] = useState([]); // { id, name, size, state: 'sending' | 'sent' | error message }
  const [over, setOver] = useState(false);
  async function send(files) {
    try { localStorage.setItem('nw.requestFrom', from); } catch { /* private window */ }
    for (const file of files) {
      const id = Math.random().toString(36).slice(2);
      // The request's own limits, checked here first (the server checks again): no waiting to be told.
      const wrong = notTaken(file, info);
      if (wrong) { setSent((list) => [...list, { id, name: file.name, size: file.size, state: wrong }]); continue; }
      setSent((list) => [...list, { id, name: file.name, size: file.size, state: 'sending' }]);
      try {
        const res = await fetch(`/api/public/links/${encodeURIComponent(token)}/upload?name=${encodeURIComponent(file.name)}${from.trim() ? `&from=${encodeURIComponent(from.trim())}` : ''}`, {
          method: 'POST', body: file,
          headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream', ...(linkKey && { 'x-link-key': linkKey }) },
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
        setSent((list) => list.map((x) => (x.id === id ? { ...x, state: 'sent' } : x)));
      } catch (e) { setSent((list) => list.map((x) => (x.id === id ? { ...x, state: e.message } : x))); }
    }
  }
  return (
    <div className="file-request stack">
      <Icon name="upload" size={40} />
      <h1>Send files to {info.owner_name}</h1>
      <p className="muted">They go into “{info.name}”. You won’t see anything else in it.</p>
      {info.note && <blockquote className="request-note" aria-label={`A note from ${info.owner_name}`}>{info.note}</blockquote>}
      {(info.accept?.length > 0 || info.max_mb) && <p className="request-takes"><strong>{info.accept?.length ? `Takes ${info.accept_text}` : 'Any kind of file'}</strong>{info.max_mb ? `, up to ${info.max_mb} MB each` : ''}.</p>}
      <label className="field"><span>Your name (so they know who sent them)</span>
        <input value={from} onChange={(e) => setFrom(e.target.value)} maxLength={100} placeholder="e.g. Bob Tan, Globex" /></label>
      <label className={`drop-zone ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send([...e.dataTransfer.files]); }}>
        <input type="file" multiple hidden aria-label="Choose files to send" accept={info.accept_attr || undefined} onChange={(e) => { send([...e.target.files]); e.target.value = ''; }} />
        <strong>Drop files here</strong><span className="muted small">or click to choose them</span>
      </label>
      {sent.length > 0 && (
        <ul className="request-sent" aria-label="Files you sent">
          {sent.map((x) => (
            <li key={x.id} className={x.state === 'sent' ? 'ok' : x.state === 'sending' ? '' : 'error'}>
              <Icon name={fileIcon({ kind: 'file', name: x.name })} size={18} /> <span className="grow ellipsis">{x.name}</span>
              <span className="small">{x.state === 'sent' ? `Sent · ${formatBytes(x.size)}` : x.state === 'sending' ? 'Sending…' : x.state}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A calendar file's events or contact cards' people, read through the link (nothing to add them to without an account). */
function LinkCards({ read, canDownload }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    read(`cards?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}`).then((x) => live && setD(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!d) return <p className="muted">Reading the file…</p>;
  return <CardsList d={d}>{canDownload && <p className="muted small">Download it to add {d.kind === 'calendar' ? 'these events to your calendar' : 'these people to your contacts'}.</p>}</CardsList>;
}

/** A Markdown file shown formatted, as a linked document is. */
function LinkMarkdown({ read }) {
  const [got, setGot] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    read('markdown').then((x) => live && setGot(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!got) return <p className="muted">Loading…</p>;
  return <div className="link-md"><Suspense fallback={<p className="muted">Loading…</p>}><LinkedItem item={got} base="" /></Suspense></div>;
}
