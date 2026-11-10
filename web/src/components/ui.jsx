import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { avatarColor } from './avatarcolor.js';
import Icon from './Icon.jsx';
import { usePhoto } from './photos.js';

export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef();
  useEffect(() => {
    // With a dialog opened from another (e.g. the picture editor inside Compose) only the top one closes.
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('.modal-backdrop');
      if (open[open.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" ref={ref} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Ask for a single line of text. */
export function PromptModal({ title, label, initial = '', confirm = 'Save', onSubmit, onClose, message }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef();
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    const dot = initial.lastIndexOf('.');
    el?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  async function submit(e) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try { await onSubmit(value.trim()); onClose(); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        {message && <p>{message}</p>}
        <label className="field"><span>{label}</span><input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !value.trim()}>{confirm}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmModal({ title, message, confirm = 'Delete', danger = true, onConfirm, onClose, children }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <p>{message}</p>
      {children}
      {error && <p className="error">{error}</p>}
      <div className="row end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} autoFocus onClick={async () => {
          setBusy(true);
          try { await onConfirm(); onClose(); } catch (e) { setError(e.message); setBusy(false); }
        }}>{confirm}</button>
      </div>
    </Modal>
  );
}

/** Small dropdown menu anchored to a trigger button. */
export function Menu({ trigger, items, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div className={`menu menu-${align}`} role="menu">
          {items.filter(Boolean).map((it, i) => it === '-' ? <hr key={i} /> : (
            <button key={i} role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}>
              {it.icon && <Icon name={it.icon} size={18} />}<span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A menu at a point (right-click). Arrow keys move between items; Escape or a click elsewhere closes it. */
export function ContextMenu({ x, y, items, onClose, label = 'Actions' }) {
  const ref = useRef();
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    const r = el.getBoundingClientRect(); // keep it on screen
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    el.querySelector('[role=menuitem]:not(:disabled)')?.focus();
    const close = (e) => !el.contains(e.target) && onClose();
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...el.querySelectorAll('[role=menuitem]:not(:disabled)')];
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose); };
  }, [x, y, onClose]);
  return (
    <div ref={ref} className="menu context-menu" role="menu" aria-label={label} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.filter(Boolean).map((it, i) => it === '-' ? <hr key={i} /> : (
        <button key={i} type="button" role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
          onClick={() => { onClose(); it.onClick(); }}>
          {it.icon && <Icon name={it.icon} size={18} />}<span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Avatar({ name = '?', size = 32, userId, email, src }) {
  const found = usePhoto(src ? undefined : userId, src ? undefined : email);
  const photo = src || found;
  if (photo) return <img className="avatar photo" src={photo} alt="" width={size} height={size} style={{ width: size, height: size }} aria-hidden="true" />;
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '?';
  return <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: avatarColor(name) }} aria-hidden="true">{initials}</span>;
}

export function Empty({ icon, title, children }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={48} />}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

// ---------- toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  // toast(text, kind, { action: { label, onClick }, duration }): an action shows as a button in it.
  const push = useCallback((text, kind = 'info', opts = {}) => {
    const id = Math.random();
    const close = () => setToasts((t) => t.filter((x) => x.id !== id));
    setToasts((t) => [...t, { id, text, kind, action: opts.action, close }]);
    setTimeout(close, opts.duration || (opts.action ? 8000 : 4000));
    return close;
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
            {t.action && <button type="button" className="toast-action" onClick={() => { t.close(); t.action.onClick(); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/**
 * A company data protection rule that warns (the server answers 409 with what it found): ask, and on
 * "Share anyway" do it again with dlpConfirmed. run(call) calls call({}) (then call({ dlpConfirmed: true }))
 * and gives its result, or undefined if they didn't go ahead. Put `modal` in the page.
 */
export function useDataCheck() {
  const [ask, setAsk] = useState(null);
  const run = async (call) => {
    try { return await call({}); } catch (e) {
      if (e.status !== 409 || !e.data?.dlp) throw e;
      return new Promise((resolve, reject) => setAsk({ text: e.message, go: () => call({ dlpConfirmed: true }).then(resolve, reject), stop: () => resolve(undefined) }));
    }
  };
  const close = (fn) => { const a = ask; setAsk(null); fn(a); };
  const modal = ask && (
    <Modal title="Check before sharing" onClose={() => close((a) => a.stop())}
      footer={<><button type="button" className="btn" onClick={() => close((a) => a.stop())}>Don’t share</button><button type="button" className="btn primary" onClick={() => close((a) => a.go())}>Share anyway</button></>}>
      <p style={{ margin: 0 }} role="alert">{ask.text}</p>
      <p className="muted small">Your company asks you to check before this leaves the company. If you share it anyway, that’s recorded.</p>
    </Modal>
  );
  return [modal, run];
}

// The same question from anywhere (a toast's button, a loop over files): one prompt, mounted once in App.
let askHost = null;
/** Mount once near the root: shows the data protection question withDataCheck asks. */
export function DataCheckHost() {
  const [ask, setAsk] = useState(null);
  useEffect(() => { askHost = setAsk; return () => { if (askHost === setAsk) askHost = null; }; }, []);
  if (!ask) return null;
  const answer = (ok) => { setAsk(null); ask.answer(ok); };
  // On top of whatever asked (Compose, a toast's page): at the end of the page.
  return createPortal(
    <Modal title="Check before sharing" onClose={() => answer(false)}
      footer={<><button type="button" className="btn" onClick={() => answer(false)}>Don’t share</button><button type="button" className="btn primary" onClick={() => answer(true)}>Share anyway</button></>}>
      <p style={{ margin: 0 }} role="alert">{ask.text}</p>
      <p className="muted small">Your company asks you to check before this leaves the company. If you share it anyway, that’s recorded.</p>
    </Modal>, document.body);
}
/** call({}) and, if a data protection rule warns, ask (DataCheckHost) and call({ dlpConfirmed: true }); undefined if they said no. */
export async function withDataCheck(call) {
  try { return await call({}); } catch (e) {
    if (e.status !== 409 || !e.data?.dlp || !askHost) throw e;
    const ok = await new Promise((answer) => askHost({ text: e.message, answer }));
    return ok ? call({ dlpConfirmed: true }) : undefined;
  }
}
