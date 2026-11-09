// The link box (Docs, 🔗 or Ctrl+K): a web or email address, or a heading or bookmark in this document.
// On a link already there, it changes or removes it; with nothing selected, it adds the link's text too.
import { useMemo, useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { placesOf, cleanHref, describeHref } from './linkplaces.js';

export function LinkDialog({ editor, onClose }) {
  const editing = editor.isActive('link');
  const needText = !editing && editor.state.selection.empty;
  const [href, setHref] = useState(editing ? editor.getAttributes('link').href || '' : '');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const places = useMemo(() => placesOf(editor.state.doc), [editor]);
  const typed = href.trim().toLowerCase();
  const shown = typed && !typed.startsWith('#') && /\s|^[^.:/@]*$/.test(typed)
    ? places.filter((p) => p.text.toLowerCase().includes(typed)) // typing words narrows the list
    : places;

  const apply = (value, label) => {
    const r = cleanHref(value);
    if (r.error) { setError(r.error); return; }
    const c = editor.chain().focus();
    if (needText) {
      const words = text.trim() || label || describeHref(r.href, places);
      c.insertContent([{ type: 'text', text: words, marks: [{ type: 'link', attrs: { href: r.href } }] }, { type: 'text', text: ' ' }]).run();
    } else c.extendMarkRange('link').setLink({ href: r.href }).run();
    onClose();
  };
  const remove = () => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); onClose(); };

  return (
    <Modal title={editing ? 'Edit link' : 'Insert link'} onClose={onClose} footer={<>
      {editing && <button type="button" className="btn danger" onClick={remove}>Remove link</button>}
      <div className="grow" />
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" onClick={() => apply(href)}>Apply</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); apply(href); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); apply(href); } }}>
        {needText && <label className="field">Text<input value={text} onChange={(e) => setText(e.target.value)} placeholder="What the link says" /></label>}
        <label className="field">Address
          <input autoFocus value={href} onChange={(e) => { setHref(e.target.value); setError(''); }} placeholder="A web address, an email address, or search the headings below"
            aria-invalid={!!error} aria-describedby={error ? 'link-error' : undefined} />
        </label>
        {error && <p id="link-error" className="error small" role="alert">{error}</p>}
      </form>
      {places.length > 0 && (
        <div className="link-places">
          <p className="muted small">Headings and bookmarks in this document</p>
          {shown.length ? (
            <ul aria-label="Headings and bookmarks">
              {shown.map((p) => (
                <li key={p.href}>
                  <button type="button" className={`link-place ${href === p.href ? 'on' : ''}`} style={p.kind === 'heading' ? { paddingLeft: 8 + 14 * (p.level - 1) } : undefined}
                    aria-label={`${p.kind === 'heading' ? 'Heading' : 'Bookmark'}: ${p.text}`} onClick={() => apply(p.href, p.text)}>
                    <span aria-hidden="true">{p.kind === 'heading' ? '§' : '🔖'}</span> {p.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">No headings or bookmarks with those words.</p>}
        </div>
      )}
    </Modal>
  );
}
