import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useEditor, EditorContent, Mark } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TextStyle, Color, BackgroundColor } from '@tiptap/extension-text-style';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { get, patch, uploadFile } from '../../api.js';
import { useAuth } from '../../App.jsx';
import { useToast, Avatar, Menu } from '../../components/ui.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { EditorHeader } from '../editorCommon.jsx';
import { CommentsPanel, useComments } from '../comments.jsx';
import Icon from '../../components/Icon.jsx';

/** Marks the text a comment is about (several comments may overlap); it travels with the text. */
const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes: () => ({ id: { default: null, parseHTML: (el) => el.getAttribute('data-comment'), renderHTML: (a) => ({ 'data-comment': a.id }) } }),
  parseHTML: () => [{ tag: 'span[data-comment]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', { ...HTMLAttributes, class: 'comment-mark' }, 0],
  addStorage: () => ({ start: null }), // set by the editor page: starts a comment on the selection
  addKeyboardShortcuts() { return { 'Mod-Alt-m': () => { this.storage.start?.(); return true; } }; },
});

/**
 * A picture in the document: a Drive file, by id, shown through the document's own address so
 * that everyone who can open the document sees it. Size (share of the page width) and alignment.
 */
const DocImage = Image.extend({
  addOptions() { return { ...this.parent?.(), docId: null }; },
  addAttributes: () => ({
    fileId: { default: null, parseHTML: (el) => el.getAttribute('data-file'), renderHTML: () => ({}) },
    alt: { default: '' },
    width: { default: null, parseHTML: (el) => el.getAttribute('data-width'), renderHTML: () => ({}) },
    align: { default: null, parseHTML: (el) => el.getAttribute('data-align'), renderHTML: () => ({}) },
  }),
  parseHTML: () => [{ tag: 'img[data-file]' }],
  renderHTML({ node }) {
    const { fileId, alt, width, align } = node.attrs;
    return ['img', {
      src: `/api/files/${this.options.docId}/pictures/${fileId}`, alt, 'data-file': fileId, draggable: 'true',
      ...(width && { 'data-width': width }), ...(align && { 'data-align': align }),
      style: `${width ? `width:${width};` : ''}${align === 'center' ? 'margin-left:auto;margin-right:auto;' : align === 'right' ? 'margin-left:auto;margin-right:0;' : ''}`,
    }];
  },
});
export const PICTURE_SIZES = [['25%', 'Small'], ['50%', 'Medium'], ['75%', 'Large'], ['', 'Full width']];
const TEXT_COLORS = [['', 'Automatic'], ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#1a73e8', 'Blue'], ['#8430ce', 'Purple'], ['#5f6368', 'Grey']];
const HIGHLIGHTS = [['', 'None'], ['#fde293', 'Yellow'], ['#ceead6', 'Green'], ['#d2e3fc', 'Blue'], ['#fad2cf', 'Red'], ['#e9d2fd', 'Purple']];
const PICTURE_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;

/** Where in the document a comment's text is: [{ from, to }]. */
function rangesOf(editor, id) {
  const out = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.marks.some((m) => m.type.name === 'comment' && m.attrs.id === id)) {
      const last = out[out.length - 1];
      if (last && last.to === pos) last.to = pos + node.nodeSize; else out.push({ from: pos, to: pos + node.nodeSize });
    }
  });
  return out;
}

const CARET_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#8430ce', '#00796b', '#c2185b', '#5f6368'];
const colorFor = (id) => CARET_COLORS[[...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % CARET_COLORS.length];

/**
 * A document everyone with access edits together: changes go to the others as you type and merge
 * (Yjs), with each person's cursor shown. The server keeps and saves the shared document.
 */
export default function DocEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [file, setFile] = useState(null);
  useEffect(() => {
    get(`/files/${id}`).then((f) => { setFile(f); document.title = `${f.name} · Docs`; }).catch((e) => { toast(e.message, 'error'); navigate('/drive'); });
    return () => { document.title = 'Workspace'; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!file) return <div className="editor-page"><EditorHeader icon="doc" file={null} status="saved" /></div>;
  return <SharedDoc key={id} file={file} setFile={setFile} />;
}

function SharedDoc({ file, setFile }) {
  const { user } = useAuth();
  const toast = useToast();
  const [sharing, setSharing] = useState(false);
  const [status, setStatus] = useState('connecting');
  const [others, setOthers] = useState([]);
  const readOnly = file.role === 'viewer';

  // One shared document per open editor; the provider keeps it in step with the server.
  const { ydoc, provider } = useMemo(() => {
    const ydoc = new Y.Doc();
    const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/collab`;
    const provider = new WebsocketProvider(url, file.id, ydoc, { maxBackoffTime: 5000 });
    return { ydoc, provider };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);
  useEffect(() => () => { provider.destroy(); ydoc.destroy(); }, [provider, ydoc]);

  useEffect(() => {
    const onStatus = ({ status: s }) => setStatus(s === 'connected' ? (provider.synced ? 'saved' : 'connecting') : s === 'disconnected' ? 'offline' : 'connecting');
    const onSync = (synced) => { if (synced) setStatus('saved'); };
    // Restoring a version: everyone starts again from the restored document.
    const onClose = (e) => { if (e?.code === 4000) window.location.reload(); };
    provider.on('status', onStatus);
    provider.on('sync', onSync);
    provider.on('connection-close', onClose);
    const people = () => setOthers([...provider.awareness.getStates().entries()]
      .filter(([cid, s]) => cid !== ydoc.clientID && s.user).map(([cid, s]) => ({ cid, ...s.user })));
    provider.awareness.on('change', people);
    return () => { provider.off('status', onStatus); provider.off('sync', onSync); provider.off('connection-close', onClose); provider.awareness.off('change', people); };
  }, [provider, ydoc]);

  const addPicturesRef = useRef(null); // set below, once the editor is there
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, undoRedo: false }), // undo is per person, from Collaboration
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Start typing…' }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: { name: user.name, color: colorFor(user.id), id: user.id } }),
      CommentMark,
      DocImage.configure({ docId: file.id }),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      TextStyle, Color, BackgroundColor,
    ],
    editable: !readOnly,
    editorProps: {
      // Pictures pasted or dropped in go to Drive and into the document.
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files || [])].filter((f) => PICTURE_TYPES.test(f.type));
        if (!files.length) return false;
        event.preventDefault();
        addPicturesRef.current?.(files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files || [])].filter((f) => PICTURE_TYPES.test(f.type));
        if (!files.length) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        addPicturesRef.current?.(files, at);
        return true;
      },
    },
  }, [ydoc]);

  // Pictures: uploaded next to the document (or to your Drive), then put in at the cursor.
  addPicturesRef.current = async (files, at) => {
    for (const f of files) {
      if (!PICTURE_TYPES.test(f.type)) { toast('Choose a picture (PNG, JPEG, GIF or WebP)', 'error'); continue; }
      try {
        let up;
        try { up = await uploadFile(f, file.parent_id || null); } catch { up = await uploadFile(f, null); }
        const node = { type: 'image', attrs: { fileId: up.id, alt: f.name.replace(/\.[a-z0-9]+$/i, '') } };
        if (at !== undefined) { editor.chain().focus().insertContentAt(at, node).run(); at = undefined; } else editor.chain().focus().insertContent(node).run();
      } catch (e) { toast(e.message, 'error'); }
    }
  };

  useEffect(() => {
    if (!editor || readOnly) return;
    const focusOnce = (synced) => { if (synced) { editor.commands.focus('start'); provider.off('sync', focusOnce); } };
    if (provider.synced) focusOnce(true); else provider.on('sync', focusOnce);
    return () => provider.off('sync', focusOnce);
  }, [editor, provider, readOnly]);

  function exportHtml() {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(file.name)}</title></head><body>${editor.getHTML()}</body></html>`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = `${file.name}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- comments ----
  const [params] = useSearchParams();
  const { threads } = useComments(file.id);
  const [panel, setPanel] = useState(!!params.get('comment'));
  const [active, setActive] = useState(params.get('comment'));
  const [pending, setPending] = useState(null);
  const startComment = () => {
    editor.view.domObserver?.flush?.(); // take in a selection just made with the keyboard
    const { from, to, empty } = editor.state.selection;
    if (empty || readOnly) return;
    const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, '');
    const quote = editor.state.doc.textBetween(from, to, ' ').slice(0, 200);
    editor.chain().setMark('comment', { id }).run(); // highlight it while the comment is written
    setPanel(true);
    setPending({ id, anchor: { quote }, label: `“${quote.length > 60 ? `${quote.slice(0, 60)}…` : quote}”`,
      onCreated: () => setPending(null),
      onCancel: () => { removeMark(id); setPending(null); } });
  };
  if (editor) editor.storage.comment.start = startComment; // Ctrl+Alt+M
  const removeMark = (id) => { const tr = editor.state.tr; for (const r of rangesOf(editor, id)) tr.removeMark(r.from, r.to, editor.schema.marks.comment.create({ id })); editor.view.dispatch(tr); };
  const showThread = (t) => {
    const [r] = rangesOf(editor, t.id);
    if (!r) return;
    editor.commands.setTextSelection(r);
    editor.view.dom.querySelector(`[data-comment="${t.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  // Clicking commented text opens its thread.
  useEffect(() => {
    if (!editor) return;
    const onClick = (e) => { const id = e.target.closest?.('[data-comment]')?.getAttribute('data-comment'); if (id && threads.some((t) => t.id === id)) { setActive(id); setPanel(true); } };
    const dom = editor.view.dom;
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [editor, threads]);
  // Opened from a mention: jump to that comment once the document is here.
  useEffect(() => { if (editor && status === 'saved' && params.get('comment')) { const t = threads.find((x) => x.id === params.get('comment')); if (t) showThread(t); } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, status, threads.length]);
  const open = threads.filter((t) => !t.resolved);
  // Highlight open comments, the selected one more strongly.
  const lit = [...open.map((t) => t.id), ...(pending ? [pending.id] : [])];
  const highlight = `${lit.map((id) => `.paper [data-comment="${id}"]`).join(',') || '.none'}{background:rgba(251,188,4,.28);border-bottom:2px solid rgba(251,188,4,.9);cursor:pointer}${active ? `.paper [data-comment="${active}"]{background:rgba(251,188,4,.55)}` : ''}`;

  if (!editor) return null;
  // The same person in two tabs shows once.
  const people = [...new Map(others.map((p) => [p.id, p])).values()].filter((p) => p.id !== user.id);

  return (
    <div className="editor-page doc-page">
      <EditorHeader
        icon="doc" file={file} status={status}
        onRename={async (name) => setFile(await patch(`/files/${file.id}`, { name }))}
        onShare={() => setSharing(true)}
        extra={<>
          <button type="button" className={`btn small ${panel ? 'primary' : ''}`} aria-pressed={panel} onClick={() => setPanel(!panel)} title="Comments">
            <Icon name="chat" size={16} /> {open.length || ''}<span className="sr-only">Comments</span>
          </button>
          {people.length > 0 && (
          <div className="coeditors" aria-label={`Also here: ${people.map((p) => p.name).join(', ')}`}>
            {people.slice(0, 4).map((p) => <span key={p.id} className="coeditor" style={{ '--c': p.color }} title={`${p.name} is here`}><Avatar name={p.name} size={28} /></span>)}
            {people.length > 4 && <span className="muted small">+{people.length - 4}</span>}
          </div>
          )}
        </>}
        menu={[
          { label: 'Print / Save as PDF', icon: 'print', onClick: () => window.print() },
          { label: 'Download as HTML', icon: 'download', onClick: exportHtml },
          { label: 'Download as Word (.docx)', icon: 'download', onClick: () => { window.location.href = `/api/files/${file.id}/export`; } },
        ]}
      />
      {!readOnly && <Toolbar editor={editor} onComment={startComment} onPictures={(files) => addPicturesRef.current(files)} />}
      <style>{highlight}</style>
      {status === 'offline' && <div className="banner warn">You're offline. Keep typing: your changes are kept here and sync when the connection is back.</div>}
      {readOnly && <div className="banner">View only. Ask {file.owner_name} for edit access.</div>}
      <div className="doc-body">
        <div className="doc-scroll" onClick={(e) => e.target === e.currentTarget && editor.commands.focus('end')}>
          <div className="paper"><EditorContent editor={editor} /></div>
        </div>
        {panel && <CommentsPanel fileId={file.id} threads={threads} canEdit={!readOnly} active={active} setActive={setActive} pending={pending}
          onShow={showThread} labelOf={(t) => `“${(t.anchor?.quote || '').slice(0, 60)}”`} onDeleted={(t) => removeMark(t.id)}
          onClose={() => { if (pending) pending.onCancel(); setPanel(false); }} />}
      </div>
      {sharing && <ShareDialog file={file} onClose={() => setSharing(false)} />}
    </div>
  );
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function Toolbar({ editor, onComment, onPictures }) {
  const pictureInput = useRef();
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    editor.on('selectionUpdate', f);
    editor.on('transaction', f);
    return () => { editor.off('selectionUpdate', f); editor.off('transaction', f); };
  }, [editor]);

  const c = () => editor.chain().focus();
  const B = ({ label, title, active, onClick, className = '' }) => (
    <button type="button" className={`tb ${active ? 'on' : ''} ${className}`} title={title} aria-label={title} aria-pressed={!!active}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  const block = editor.isActive('heading', { level: 1 }) ? 'h1' : editor.isActive('heading', { level: 2 }) ? 'h2'
    : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p';

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <B label="↶" title="Undo (Ctrl+Z)" onClick={() => c().undo().run()} />
      <B label="↷" title="Redo (Ctrl+Y)" onClick={() => c().redo().run()} />
      <span className="sep" />
      <select aria-label="Text style" value={block} onChange={(e) => {
        const v = e.target.value;
        if (v === 'p') c().setParagraph().run(); else c().setHeading({ level: Number(v[1]) }).run();
      }}>
        <option value="p">Normal text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option>
      </select>
      <span className="sep" />
      <B label={<b>B</b>} title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => c().toggleBold().run()} />
      <B label={<i>I</i>} title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => c().toggleItalic().run()} />
      <B label={<u>U</u>} title="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={() => c().toggleUnderline().run()} />
      <B label={<s>S</s>} title="Strikethrough" active={editor.isActive('strike')} onClick={() => c().toggleStrike().run()} />
      <B label="</>" title="Inline code" active={editor.isActive('code')} onClick={() => c().toggleCode().run()} />
      <B label="🔗" title="Link" active={editor.isActive('link')} onClick={() => {
        if (editor.isActive('link')) return c().unsetLink().run();
        const url = window.prompt('Link URL');
        if (url && /^(https?:|mailto:|\/)/i.test(url)) c().extendMarkRange('link').setLink({ href: url }).run();
      }} />
      <span className="sep" />
      <B label="⯇" title="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => c().setTextAlign('left').run()} />
      <B label="≡" title="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => c().setTextAlign('center').run()} />
      <B label="⯈" title="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => c().setTextAlign('right').run()} />
      <span className="sep" />
      <B label="•" title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()} />
      <B label="1." title="Numbered list" active={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()} />
      <B label="❝" title="Quote" active={editor.isActive('blockquote')} onClick={() => c().toggleBlockquote().run()} />
      <B label="{ }" title="Code block" active={editor.isActive('codeBlock')} onClick={() => c().toggleCodeBlock().run()} />
      <B label="―" title="Horizontal line" onClick={() => c().setHorizontalRule().run()} />
      <B label="Tx" title="Clear formatting" onClick={() => c().unsetAllMarks().clearNodes().run()} />
      <span className="sep" />
      <label className="tb-color" title="Text colour"><span className="color-a" aria-hidden="true">A<span className="color-bar" style={{ background: editor.getAttributes('textStyle').color || 'currentColor' }} /></span>
        <select aria-label="Text colour" value={editor.getAttributes('textStyle').color || ''} onChange={(e) => (e.target.value ? c().setColor(e.target.value).run() : c().unsetColor().run())}>
          {TEXT_COLORS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
        </select></label>
      <label className="tb-color" title="Highlight"><span className="fill-swatch" aria-hidden="true" style={{ background: editor.getAttributes('textStyle').backgroundColor || 'transparent' }} />
        <select aria-label="Highlight" value={editor.getAttributes('textStyle').backgroundColor || ''} onChange={(e) => (e.target.value ? c().setBackgroundColor(e.target.value).run() : c().unsetBackgroundColor().run())}>
          {HIGHLIGHTS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
        </select></label>
      <span className="sep" />
      <button type="button" className="tb labelled" title="Insert a picture (or paste or drop one in)" aria-label="Insert picture" onMouseDown={(e) => e.preventDefault()} onClick={() => pictureInput.current.click()}><Icon name="image" size={18} /> Picture</button>
      <input ref={pictureInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { onPictures([...e.target.files]); e.target.value = ''; }} />
      {editor.isActive('image') && <>
        <select className="tb-select" aria-label="Picture size" value={editor.getAttributes('image').width || ''} onChange={(e) => c().updateAttributes('image', { width: e.target.value || null }).run()}>
          {PICTURE_SIZES.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
        </select>
        {[['left', 'Picture on the left', '⯇'], ['center', 'Picture in the centre', '≡'], ['right', 'Picture on the right', '⯈']].map(([a, t, g]) => (
          <B key={a} label={g} title={t} active={(editor.getAttributes('image').align || 'left') === a} onClick={() => c().updateAttributes('image', { align: a === 'left' ? null : a }).run()} />
        ))}
      </>}
      <Menu align="left" trigger={(p) => <button type="button" className="tb labelled" title="Table" aria-label="Table" onMouseDown={(e) => e.preventDefault()} {...p}><TableGlyph /> Table</button>} items={[
        { label: 'Insert table (3 × 3)', onClick: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), disabled: editor.isActive('table') },
        '-',
        { label: 'Add row above', onClick: () => c().addRowBefore().run(), disabled: !editor.can().addRowBefore() },
        { label: 'Add row below', onClick: () => c().addRowAfter().run(), disabled: !editor.can().addRowAfter() },
        { label: 'Add column left', onClick: () => c().addColumnBefore().run(), disabled: !editor.can().addColumnBefore() },
        { label: 'Add column right', onClick: () => c().addColumnAfter().run(), disabled: !editor.can().addColumnAfter() },
        { label: 'Heading row on or off', onClick: () => c().toggleHeaderRow().run(), disabled: !editor.can().toggleHeaderRow() },
        '-',
        { label: 'Delete row', icon: 'trash', danger: true, onClick: () => c().deleteRow().run(), disabled: !editor.can().deleteRow() },
        { label: 'Delete column', icon: 'trash', danger: true, onClick: () => c().deleteColumn().run(), disabled: !editor.can().deleteColumn() },
        { label: 'Delete table', icon: 'trash', danger: true, onClick: () => c().deleteTable().run(), disabled: !editor.can().deleteTable() },
      ]} />
      <span className="sep" />
      <button type="button" className="tb labelled" title="Comment on the selected text (Ctrl+Alt+M)" aria-label="Add comment" disabled={editor.state.selection.empty}
        onMouseDown={(e) => e.preventDefault()} onClick={onComment}><Icon name="chat" size={18} /> Comment</button>
    </div>
  );
}

function TableGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4h18v16H3V4zm2 2v3h6V6H5zm8 0v3h6V6h-6zm-8 5v3h6v-3H5zm8 0v3h6v-3h-6zm-8 5v2h6v-2H5zm8 0v2h6v-2h-6z" /></svg>;
}
