import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import { get, patch, onLive } from '../../api.js';
import { useAuth } from '../../App.jsx';
import { useToast } from '../../components/ui.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { useAutosave, EditorHeader } from '../editorCommon.jsx';

export default function DocEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [file, setFile] = useState(null);
  const [sharing, setSharing] = useState(false);
  const readOnly = file && file.role === 'viewer';

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Start typing…' }),
    ],
    editable: false,
    onUpdate: ({ editor }) => {
      // Ignore no-op updates (e.g. plugins normalising the doc on load).
      if (!editor.isEditable || JSON.stringify(editor.getJSON()) === baseline.current) return;
      baseline.current = null;
      saver.current?.changed(() => editor.getJSON());
    },
  });
  const baseline = useRef(null);
  const setBaseline = () => { baseline.current = JSON.stringify(editor.getJSON()); };

  const save = useAutosave(id);
  const saver = useRef(save);
  saver.current = save;

  useEffect(() => {
    if (!editor) return;
    get(`/files/${id}/content`).then(({ file, content }) => {
      setFile(file);
      document.title = `${file.name} · Docs`;
      save.setVersion(file.version);
      editor.commands.setContent(content, { emitUpdate: false });
      setBaseline();
      editor.setEditable(file.role !== 'viewer');
      if (file.role !== 'viewer') editor.commands.focus('start');
    }).catch((e) => { toast(e.message, 'error'); navigate('/drive'); });
    return () => { document.title = 'Workspace'; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, editor]);

  // Someone else saved: pull their version if we have no unsaved edits.
  useEffect(() => onLive(async (m) => {
    if (m.type !== 'content-changed' || m.id !== id || m.by === user.id) return;
    if (save.isDirty()) { save.markConflict(m.by_name); return; }
    const { file, content } = await get(`/files/${id}/content`);
    save.setVersion(file.version);
    const sel = editor.state.selection;
    editor.commands.setContent(content, { emitUpdate: false });
    setBaseline();
    try { editor.commands.setTextSelection({ from: Math.min(sel.from, editor.state.doc.content.size), to: Math.min(sel.to, editor.state.doc.content.size) }); } catch {}
    toast(`${m.by_name} updated this document`);
  }), [id, editor, user.id, save, toast]);

  async function reloadTheirs() {
    const { file, content } = await get(`/files/${id}/content`);
    save.setVersion(file.version);
    save.resolve();
    editor.commands.setContent(content, { emitUpdate: false });
    setBaseline();
  }

  function exportHtml() {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(file.name)}</title></head><body>${editor.getHTML()}</body></html>`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download = `${file.name}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!editor) return null;

  return (
    <div className="editor-page doc-page">
      <EditorHeader
        icon="doc" file={file} status={save.status}
        onRename={async (name) => setFile(await patch(`/files/${id}`, { name }))}
        onShare={() => setSharing(true)}
        menu={[
          { label: 'Print / Save as PDF', icon: 'print', onClick: () => window.print() },
          { label: 'Download as HTML', icon: 'download', onClick: exportHtml },
        ]}
      />
      {!readOnly && <Toolbar editor={editor} />}
      {save.conflict && (
        <div className="banner warn">
          {save.conflict} changed this document while you were editing.
          <button className="btn small" onClick={reloadTheirs}>Load their version</button>
          <button className="btn small" onClick={() => save.forceSave(editor.getJSON())}>Keep mine</button>
        </div>
      )}
      {readOnly && <div className="banner">View only. Ask {file.owner_name} for edit access.</div>}
      <div className="doc-scroll" onClick={(e) => e.target === e.currentTarget && editor.commands.focus('end')}>
        <div className="paper"><EditorContent editor={editor} /></div>
      </div>
      {sharing && <ShareDialog file={file} onClose={() => setSharing(false)} />}
    </div>
  );
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function Toolbar({ editor }) {
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
    </div>
  );
}
