// The page someone without an account sees when they open a share link: /s/<token>.
import { useEffect, useState } from 'react';
import { formatBytes, formatDate } from '../api.js';
import Icon, { fileIcon } from '../components/Icon.jsx';

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
  else if (info.kind === 'file') body = <FileView file={info} src={raw()} download={raw(null, true)} />;
  else if (open) body = (
    <>
      <button type="button" className="link-btn" onClick={() => setOpen(null)}><Icon name="back" size={18} /> Back to {info.path.at(-1).name}</button>
      <FileView file={open} src={raw(open.id)} download={raw(open.id, true)} />
    </>
  );
  else body = <FolderView info={info} onFolder={(id) => setFolder(id === info.root ? null : id)} onOpen={setOpen} download={(id) => raw(id, true)} />;

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

function FileView({ file, src, download }) {
  const m = file.mime || '';
  let preview = null;
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(m)) preview = <img src={src} alt={file.name} className="preview-media" />;
  else if (/^video\/(mp4|webm)$/.test(m)) preview = <video src={src} controls className="preview-media" />;
  else if (m.startsWith('audio/')) preview = <audio src={src} controls />;
  else if (m === 'application/pdf' || /^text\/(plain|csv|markdown)$/.test(m)) preview = <iframe src={src} title={file.name} className="preview-frame" />;
  return (
    <section className="link-file stack">
      <div className="row link-file-head">
        <Icon name={fileIcon(file)} size={32} />
        <div className="grow"><h1 className="ellipsis">{file.name}</h1><p className="muted small">{formatBytes(file.size)} · modified {formatDate(file.updated_at)}</p></div>
        <a className="btn primary" href={download}><Icon name="download" size={18} /> Download</a>
      </div>
      {preview ? <div className="preview">{preview}</div> : <p className="muted">No preview for this kind of file. Download it to open it on your device.</p>}
    </section>
  );
}

function FolderView({ info, onFolder, onOpen, download }) {
  return (
    <section className="link-folder stack">
      <nav className="crumbs" aria-label="Folder path">
        {info.path.map((p, i) => i < info.path.length - 1
          ? <span key={p.id}><button type="button" className="link-btn" onClick={() => onFolder(p.id)}>{p.name}</button> / </span>
          : <h1 key={p.id}>{p.name}</h1>)}
      </nav>
      {info.items.length === 0 ? <p className="muted">This folder is empty.</p> : (
        <ul className="link-items">
          {info.items.map((f) => (
            <li key={f.id}>
              <Icon name={fileIcon(f)} size={22} />
              <button type="button" className="link-btn grow ellipsis" onClick={() => (f.kind === 'folder' ? onFolder(f.id) : onOpen(f))}>{f.name}</button>
              {f.kind === 'file' && <><span className="muted small">{formatBytes(f.size)}</span>
                <a className="icon-btn" href={download(f.id)} aria-label={`Download ${f.name}`}><Icon name="download" size={18} /></a></>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
      <label className="field"><span>Your name (so they know who sent them)</span>
        <input value={from} onChange={(e) => setFrom(e.target.value)} maxLength={100} placeholder="e.g. Bob Tan, Globex" /></label>
      <label className={`drop-zone ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send([...e.dataTransfer.files]); }}>
        <input type="file" multiple hidden aria-label="Choose files to send" onChange={(e) => { send([...e.target.files]); e.target.value = ''; }} />
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
