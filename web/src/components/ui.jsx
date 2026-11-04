import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

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
export function PromptModal({ title, label, initial = '', confirm = 'Save', onSubmit, onClose }) {
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

export function ConfirmModal({ title, message, confirm = 'Delete', danger = true, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <p>{message}</p>
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

export function Avatar({ name = '?', size = 32 }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '?';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${h} 55% 45%)` }} aria-hidden="true">{initials}</span>;
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
  const push = useCallback((text, kind = 'info') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
