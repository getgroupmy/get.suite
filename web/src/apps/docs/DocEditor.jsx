import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useEditor, EditorContent, Mark } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TextStyle, Color, BackgroundColor, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { FONTS, SIZES, LINE_HEIGHTS, fontChoice, LineHeight } from './typography.js';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { get, post, patch, put, uploadFile, onLive } from '../../api.js';
import DrivePicker, { openUrl } from '../../components/DrivePicker.jsx';
import { useAuth } from '../../App.jsx';
import { useToast, Avatar, Menu, Modal } from '../../components/ui.jsx';
import { PAPER, MARGINS, DEFAULT_SETUP, paperStyle, printCss } from './pagesetup.js';
import { ShareDialog } from '../drive/Drive.jsx';
import { EditorHeader } from '../editorCommon.jsx';
import { CommentsPanel, useComments } from '../comments.jsx';
import Icon from '../../components/Icon.jsx';
import { FindReplace, countWords } from './findReplace.js';
import { FindBar } from './FindBar.jsx';
import { Outline } from './Outline.jsx';
import { TableOfContents, htmlWithContents } from './toc.js';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { PageBreak } from './pagebreak.js';
import { Footnote, footnotesOf, htmlWithFootnotes } from './footnote.js';
import { Mention, mentionQuery, matchPeople } from './mention.js';
import { diffDocs, changeCount } from './docdiff.js';
import { VersionHistory } from '../VersionHistory.jsx';
import { SuggestInsert, SuggestDelete, SuggestMode, listSuggestions, resolveSuggestion, describeSuggestion } from './suggest.js';

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
/** Where a quote is in the document (for comments without a highlight, from commenters): [{ from, to }] or []. */
function quoteRange(editor, quote) {
  if (!quote) return [];
  let found = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const i = node.text.indexOf(quote.slice(0, 60));
    if (i >= 0) found = { from: pos + i, to: pos + i + Math.min(quote.length, node.text.length - i) };
    return false;
  });
  return found ? [found] : [];
}

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
    get(`/files/${id}`).then((f) => { setFile(f); document.title = `${f.name} · Docs`; }).catch((e) => { if (e.status === 404) { navigate(`/access/${id}`, { replace: true }); return; } toast(e.message, 'error'); navigate('/drive'); });
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
  const [history, setHistory] = useState(false);
  // A link to another file in Drive, named after it. If people who can open this document can't
  // open that one, the owner is offered to share it with them (everyone else is told who can't).
  const [linkingFile, setLinkingFile] = useState(false);
  const linkFile = async (f) => {
    const href = openUrl(f);
    const c = editor.chain().focus();
    if (editor.state.selection.empty) c.insertContent({ type: 'text', text: f.name, marks: [{ type: 'link', attrs: { href } }] }).insertContent(' ').run();
    else c.extendMarkRange('link').setLink({ href }).run();
    try {
      const gap = await get(`/files/${f.id}/missing-access?for=${file.id}`);
      if (!gap.people.length) return;
      const names = gap.people.map((p) => p.name).join(', ');
      if (!gap.can_share) { toast(`${names} can't open “${f.name}”. Ask its owner to share it.`, 'info', { duration: 10000 }); return; }
      toast(`${names} can't open “${f.name}”`, 'info', { duration: 15000, action: { label: 'Share with them', onClick: async () => {
        try {
          const now = await get(`/files/${f.id}/shares`);
          await put(`/files/${f.id}/shares`, { shares: [...now.map((x) => ({ user_id: x.user_id, role: x.role })), ...gap.people.map((p) => ({ user_id: p.id, role: 'viewer' }))] });
          toast(`Shared “${f.name}” with ${names} (can view)`);
        } catch (e) { toast(e.message, 'error'); }
      } } });
    } catch { /* checking is a courtesy */ }
  };
  const [status, setStatus] = useState('connecting');
  const [others, setOthers] = useState([]);
  const readOnly = (file.role === 'viewer' || file.role === 'commenter') || !!file?.locked_at;
  const canComment = !!file && file.role !== 'viewer'; // commenters too, and on locked files

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
  const mentionKeyRef = useRef(null); // the @-picker's keys, while it's open
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, undoRedo: false }), // undo is per person, from Collaboration
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Start typing…' }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: { name: user.name, color: colorFor(user.id), id: user.id } }),
      CommentMark,
      DocImage.configure({ docId: file.id }),
      FindReplace,
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      TextStyle, Color, BackgroundColor, FontFamily, FontSize, LineHeight, TableOfContents,
      SuggestInsert, SuggestDelete, SuggestMode,
      PageBreak, Footnote, Mention, TaskList, TaskItem.configure({ nested: true }), // checklists: everyone sees the ticks live; viewers can't tick
    ],
    editable: !readOnly,
    editorProps: {
      // A key pressed right after a click (Enter, Backspace…) acts where the click put the cursor,
      // even if the browser hasn't told the editor about the new selection yet.
      handleKeyDown: (view, event) => { view.domObserver?.flush?.(); return mentionKeyRef.current?.(event) || false; },
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

  // @mentions: typing "@" and a name offers colleagues; the one picked goes in as a chip and is told.
  const [mention, setMention] = useState(null); // { from, query, left, top, list, pick }
  const [colleagues, setColleagues] = useState([]);
  useEffect(() => { if (!readOnly) get('/users/directory').then((l) => setColleagues(l.filter((p) => p.id !== user.id))).catch(() => {}); }, [readOnly, user.id]);
  useEffect(() => {
    if (!editor || readOnly) return undefined;
    const check = () => {
      const { state, view } = editor;
      const sel = state.selection;
      if (!sel.empty || !sel.$from.parent.isTextblock) { setMention(null); return; }
      const before = sel.$from.parent.textBetween(0, sel.$from.parentOffset, undefined, '\ufffc');
      const m = mentionQuery(before, sel.from);
      const list = m ? matchPeople(colleagues, m.query) : [];
      if (!m || !list.length) { setMention(null); return; }
      const c = view.coordsAtPos(sel.from);
      setMention((old) => ({ ...m, list, left: c.left, top: c.bottom + 4, pick: old && old.from === m.from ? Math.min(old.pick, list.length - 1) : 0 }));
    };
    editor.on('selectionUpdate', check);
    editor.on('update', check);
    return () => { editor.off('selectionUpdate', check); editor.off('update', check); };
  }, [editor, readOnly, colleagues]);
  const pickMention = async (p) => {
    const m = mention;
    setMention(null);
    editor.chain().focus().deleteRange({ from: m.from, to: editor.state.selection.from })
      .insertContent([{ type: 'mention', attrs: { id: p.id, name: p.name, email: p.username } }, { type: 'text', text: ' ' }]).run();
    try {
      const r = await post(`/files/${file.id}/mention`, { user_id: p.id });
      if (r.notified) toast(`${p.name} was told`);
      else if (r.no_access && r.can_share) {
        toast(`${p.name} can't open this document`, 'info', { duration: 15000, action: { label: 'Share with them', onClick: async () => {
          try {
            const now = await get(`/files/${file.id}/shares`);
            await put(`/files/${file.id}/shares`, { shares: [...now.map((x) => ({ user_id: x.user_id, role: x.role })), { user_id: p.id, role: 'editor' }] });
            await post(`/files/${file.id}/mention`, { user_id: p.id });
            toast(`Shared with ${p.name} (can edit), and they were told`);
          } catch (e) { toast(e.message, 'error'); }
        } } });
      } else if (r.no_access) toast(`${p.name} can't open this document. Ask its owner to share it.`, 'info', { duration: 10000 });
    } catch (e) { toast(e.message, 'error'); }
  };
  mentionKeyRef.current = (e) => {
    if (!mention) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { setMention({ ...mention, pick: (mention.pick + (e.key === 'ArrowDown' ? 1 : mention.list.length - 1)) % mention.list.length }); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mention.list[mention.pick]); return true; }
    if (e.key === 'Escape') { setMention(null); return true; }
    return false;
  };

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
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(file.name)}</title></head><body>${htmlWithFootnotes(htmlWithContents(withoutSuggestionsHtml(editor.getHTML()), editor.state.doc))}</body></html>`;
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

  // ---- suggesting mode ----
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [suggPanel, setSuggPanel] = useState(false);
  useEffect(() => {
    if (!editor) return undefined;
    editor.storage.suggestMode.who = { id: user.id, name: user.name };
    const update = () => setSuggestions(listSuggestions(editor.state.doc));
    update();
    editor.on('update', update);
    return () => editor.off('update', update);
  }, [editor, user.id, user.name]);
  useEffect(() => { if (editor) editor.storage.suggestMode.on = suggesting && !readOnly; }, [editor, suggesting, readOnly]);
  const resolve = (id, accept) => {
    const tr = resolveSuggestion(editor.state, id, accept);
    if (tr) editor.view.dispatch(tr);
  };
  const showSuggestion = (sg) => editor.chain().setTextSelection({ from: sg.from, to: sg.to }).scrollIntoView().run();
  const [active, setActive] = useState(params.get('comment'));
  const [pending, setPending] = useState(null);
  const [finding, setFinding] = useState(null); // { replace, n }
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  // Someone changed the page setup: the paper follows.
  useEffect(() => onLive((m) => { if (m.type === 'page-setup' && m.id === file.id) setFile((f) => ({ ...f, page_setup: m.page_setup })); }), [file.id]);
  const [outline, setOutlineState] = useState(() => { try { return localStorage.getItem('nw-doc-outline') === '1'; } catch { return false; } });
  const setOutline = (on) => { setOutlineState(on); try { localStorage.setItem('nw-doc-outline', on ? '1' : '0'); } catch { /* private window */ } };
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (k !== 'f' && k !== 'h')) return;
      if (document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      setFinding((f) => ({ replace: k === 'h' || !!f?.replace, n: (f?.n || 0) + 1 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const startComment = () => {
    editor.view.domObserver?.flush?.(); // take in a selection just made with the keyboard
    const { from, to, empty } = editor.state.selection;
    if (empty || !canComment) return;
    const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, '');
    const quote = editor.state.doc.textBetween(from, to, ' ').slice(0, 200);
    // Highlight it (editors only: commenters can't change the document, so theirs find the quoted text instead).
    if (!readOnly) editor.chain().setMark('comment', { id }).run();
    setPanel(true);
    setPending({ id, anchor: { quote }, label: `“${quote.length > 60 ? `${quote.slice(0, 60)}…` : quote}”`,
      onCreated: () => setPending(null),
      onCancel: () => { if (!readOnly) removeMark(id); setPending(null); } });
  };
  if (editor) editor.storage.comment.start = startComment; // Ctrl+Alt+M
  const removeMark = (id) => { const tr = editor.state.tr; for (const r of rangesOf(editor, id)) tr.removeMark(r.from, r.to, editor.schema.marks.comment.create({ id })); editor.view.dispatch(tr); };
  const showThread = (t) => {
    const [r] = rangesOf(editor, t.id).length ? rangesOf(editor, t.id) : quoteRange(editor, t.anchor?.quote);
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
          <button type="button" className={`btn small ${outline ? 'primary' : ''}`} aria-pressed={outline} onClick={() => setOutline(!outline)} title="Outline">
            <Icon name="menu" size={16} /><span className="sr-only">Outline</span>
          </button>
          {!readOnly && (
            <select className="doc-mode" aria-label="Editing mode" title="Suggesting: your changes show as suggestions for others to accept or reject" value={suggesting ? 'suggest' : 'edit'}
              onChange={(e) => { setSuggesting(e.target.value === 'suggest'); editor.view.focus(); }}>
              <option value="edit">✎ Editing</option><option value="suggest">💡 Suggesting</option>
            </select>
          )}
          {suggestions.length > 0 && (
            <button type="button" className={`btn small ${suggPanel ? 'primary' : ''}`} aria-pressed={suggPanel} onClick={() => setSuggPanel(!suggPanel)} title="Suggestions">
              💡 {suggestions.length}<span className="sr-only"> suggestions</span>
            </button>
          )}
          {readOnly && canComment && <button type="button" className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={startComment} title="Select some text first">Comment</button>}
          <button type="button" className={`btn small ${panel ? 'primary' : ''}`} aria-pressed={panel} onClick={() => setPanel(!panel)} title="Comments">
            <Icon name="chat" size={16} /> {open.length || ''}<span className="sr-only">Comments</span>
          </button>
          {people.length > 0 && (
          <div className="coeditors" aria-label={`Also here: ${people.map((p) => p.name).join(', ')}`}>
            {people.slice(0, 4).map((p) => <span key={p.id} className="coeditor" style={{ '--c': p.color }} title={`${p.name} is here`}><Avatar name={p.name} size={28} userId={p.id} /></span>)}
            {people.length > 4 && <span className="muted small">+{people.length - 4}</span>}
          </div>
          )}
        </>}
        menu={[
          { label: 'Find and replace', icon: 'search', onClick: () => setFinding({ replace: !readOnly }) },
          ...(!readOnly ? [{ label: 'Page setup', icon: 'print', onClick: () => setPageSetupOpen(true) }] : []),
          { label: 'Version history', icon: 'clock', onClick: () => setHistory(true) },
          { label: 'Word count', icon: 'doc', onClick: () => { const c = countWords(editor.state.doc); toast(`${c.words.toLocaleString()} ${c.words === 1 ? 'word' : 'words'}, ${c.characters.toLocaleString()} characters (without spaces)`); } },
          '-',
          { label: 'Print / Save as PDF', icon: 'print', onClick: () => window.print() },
          { label: 'Download as HTML', icon: 'download', onClick: exportHtml },
          { label: 'Download as Word (.docx)', icon: 'download', onClick: () => { window.location.href = `/api/files/${file.id}/export`; } },
          { label: 'Download as Markdown (.md)', icon: 'download', onClick: () => { window.location.href = `/api/files/${file.id}/export?format=md`; } },
        ]}
      />
      {!readOnly && <Toolbar editor={editor} onComment={startComment} onPictures={(files) => addPicturesRef.current(files)} onLinkFile={() => setLinkingFile(true)} />}
      {linkingFile && <DrivePicker title="Link to a file in Drive" accept={(x) => x.id !== file.id} empty="No files found." onClose={() => setLinkingFile(false)}
        onPick={(f) => { setLinkingFile(false); linkFile(f); }} />}
      <style>{highlight}</style>
      <style>{printCss(file.page_setup)}</style>
      {status === 'offline' && <div className="banner warn">You're offline. Keep typing: your changes are kept here and sync when the connection is back.</div>}
      {readOnly && <div className="banner">{file.locked_at ? 'Locked.' : file.role === 'commenter' ? 'You can comment, not edit.' : 'View only.'} {!file.locked_at && `Ask ${file.owner_name} for edit access.`}</div>}
      {finding && <FindBar key={finding.n} editor={editor} replacing={finding.replace} canEdit={!readOnly} onClose={() => { editor.view.focus(); setFinding(null); }} />} {/* focus back first, so it doesn't go with the bar */}
      <div className="doc-body">
        {outline && <Outline editor={editor} onClose={() => setOutline(false)} />}
        <div className="doc-scroll" onClick={(e) => e.target === e.currentTarget && editor.commands.focus('end')}>
          <div className="paper" style={file.page_setup ? paperStyle(file.page_setup) : undefined}>
            {file.page_setup?.header && <div className="paper-header" aria-hidden="true">{file.page_setup.header}</div>}
            <EditorContent editor={editor} onClick={(e) => { const sup = e.target.closest?.('sup[data-footnote]'); if (sup) focusFootnote(e.currentTarget, sup); }} />
            {mention && (
              <ul className="mention-list doc-mention-list" role="listbox" aria-label="People to mention" style={{ position: 'fixed', left: mention.left, top: mention.top }}>
                {mention.list.map((p, i) => (
                  <li key={p.id} role="option" aria-selected={i === mention.pick} className={i === mention.pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}>
                    <Avatar name={p.name} size={20} userId={p.id} /> {p.name} <span className="muted small">{p.username}</span>
                  </li>
                ))}
              </ul>
            )}
            <FootnoteList editor={editor} readOnly={readOnly} />
            {(file.page_setup?.footer || file.page_setup?.numbers) && <div className="paper-footer" aria-hidden="true">{[file.page_setup.footer, file.page_setup.numbers && 'Page 1'].filter(Boolean).join('   ')}</div>}
          </div>
        </div>
        {suggPanel && suggestions.length > 0 && (
          <aside className="comments-panel sugg-panel" aria-label="Suggestions">
            <div className="row"><strong className="grow">Suggestions</strong>
              <button type="button" className="icon-btn" aria-label="Close suggestions" onClick={() => setSuggPanel(false)}><Icon name="close" size={18} /></button></div>
            {!readOnly && <div className="row"><button type="button" className="btn small" onClick={() => resolve(null, true)}>Accept all</button><button type="button" className="btn small" onClick={() => resolve(null, false)}>Reject all</button></div>}
            <ul className="sugg-list">
              {suggestions.map((sg) => (
                <li key={sg.id} className="sugg-item" aria-label={`Suggestion by ${sg.name}`}>
                  <button type="button" className="sugg-show" onClick={() => showSuggestion(sg)}>
                    <span className="small"><strong>{sg.name || 'Someone'}</strong> <span className="muted">{sg.at ? new Date(sg.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''}</span></span>
                    <span className="sugg-what">{describeSuggestion(sg)}</span>
                  </button>
                  {!readOnly && <div className="row"><button type="button" className="btn small primary" aria-label={`Accept: ${describeSuggestion(sg)}`} onClick={() => resolve(sg.id, true)}>✓ Accept</button>
                    <button type="button" className="btn small" aria-label={`Reject: ${describeSuggestion(sg)}`} onClick={() => resolve(sg.id, false)}>✕ Reject</button></div>}
                </li>
              ))}
            </ul>
          </aside>
        )}
        {panel && <CommentsPanel fileId={file.id} threads={threads} canEdit={canComment} active={active} setActive={setActive} pending={pending}
          onShow={showThread} labelOf={(t) => `“${(t.anchor?.quote || '').slice(0, 60)}”`} onDeleted={(t) => removeMark(t.id)}
          onClose={() => { if (pending) pending.onCancel(); setPanel(false); }} />}
      </div>
      {sharing && <ShareDialog file={file} onClose={() => setSharing(false)} />}
      {history && <VersionHistory file={file} canEdit={!readOnly} onClose={() => setHistory(false)} renderPreview={(content) => <DocPreview content={content} fileId={file.id} />} renderChanges={(content) => <DocChanges before={content} after={editor.getJSON()} />} />}
      {pageSetupOpen && <PageSetupDialog setup={file.page_setup} onClose={() => { setPageSetupOpen(false); editor.view.focus(); }}
        onSave={async (next) => { try { setFile(await patch(`/files/${file.id}`, { page_setup: next })); setPageSetupOpen(false); toast('Page setup saved'); } catch (e) { toast(e.message, 'error'); } }} />}
    </div>
  );
}

/** HTML without pending suggestions: suggested insertions left out, suggested deletions kept as plain text. */
function withoutSuggestionsHtml(html) {
  const d = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  d.querySelectorAll('ins[data-sugg]').forEach((el) => el.remove());
  d.querySelectorAll('del[data-sugg]').forEach((el) => el.replaceWith(...el.childNodes));
  return d.body.innerHTML;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function Toolbar({ editor, onComment, onPictures, onLinkFile }) {
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
      {(() => {
        const ts = editor.getAttributes('textStyle');
        const font = fontChoice(ts.fontFamily);
        const lh = editor.getAttributes(editor.isActive('heading') ? 'heading' : 'paragraph').lineHeight || '';
        return <>
          <select aria-label="Font" title="Font" value={font} style={{ fontFamily: ts.fontFamily || undefined }} onChange={(e) => (e.target.value ? c().setFontFamily(e.target.value).run() : c().unsetFontFamily().run())}>
            {font === 'other' && <option value="other" disabled>{String(ts.fontFamily).split(',')[0].replace(/["']/g, '')}</option>}
            {FONTS.map(([v, n]) => <option key={n} value={v} style={{ fontFamily: v || undefined }}>{n}</option>)}
          </select>
          <select aria-label="Text size" title="Text size" value={SIZES.includes(ts.fontSize || '') ? ts.fontSize || '' : 'other'} onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())}>
            {!SIZES.includes(ts.fontSize || '') && <option value="other" disabled>{ts.fontSize}</option>}
            {SIZES.map((v) => <option key={v} value={v}>{v ? v.replace('pt', '') : 'Size'}</option>)}
          </select>
          <select aria-label="Line spacing" title="Line spacing" value={lh} onChange={(e) => c().setLineHeight(e.target.value || null).run()}>
            {LINE_HEIGHTS.map(([v, n]) => <option key={n} value={v}>{v ? `↕ ${n}` : '↕ Spacing'}</option>)}
          </select>
        </>;
      })()}
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
      <B label="📄" title="Link to a file in Drive" onClick={onLinkFile} />
      <span className="sep" />
      <B label="⯇" title="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => c().setTextAlign('left').run()} />
      <B label="≡" title="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => c().setTextAlign('center').run()} />
      <B label="⯈" title="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => c().setTextAlign('right').run()} />
      <span className="sep" />
      <B label="•" title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()} />
      <B label="1." title="Numbered list" active={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()} />
      <B label="☑" title="Checklist (or type [ ] and a space)" active={editor.isActive('taskList')} onClick={() => c().toggleTaskList().run()} />
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
      <button type="button" className="tb labelled" title="Page break: what follows starts a new page when printed or downloaded (Ctrl+Enter)" aria-label="Insert page break"
        onMouseDown={(e) => e.preventDefault()} onClick={() => c().setPageBreak().run()}>⤓ Page break</button>
      <button type="button" className="tb labelled" title="Footnote: a numbered note at the end of the document, for a source or an aside" aria-label="Insert footnote"
        onMouseDown={(e) => e.preventDefault()} onClick={() => c().insertFootnote().run()}><sup>1</sup> Footnote</button>
      <button type="button" className="tb labelled" title="Insert a table of contents: the document's headings, kept up to date, each a link" aria-label="Insert table of contents"
        onMouseDown={(e) => e.preventDefault()} onClick={() => c().insertTableOfContents().run()}><Icon name="menu" size={18} /> Contents</button>
      <span className="sep" />
      <button type="button" className="tb labelled" title="Comment on the selected text (Ctrl+Alt+M)" aria-label="Add comment" disabled={editor.state.selection.empty}
        onMouseDown={(e) => e.preventDefault()} onClick={onComment}><Icon name="chat" size={18} /> Comment</button>
    </div>
  );
}

function TableGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4h18v16H3V4zm2 2v3h6V6H5zm8 0v3h6V6h-6zm-8 5v3h6v-3H5zm8 0v3h6v-3h-6zm-8 5v2h6v-2H5zm8 0v2h6v-2h-6z" /></svg>;
}

/** Paper size, orientation, margins, and a header and footer for printing and Word. */
function PageSetupDialog({ setup, onClose, onSave }) {
  const [s, setS] = useState({ ...DEFAULT_SETUP, ...(setup || {}) });
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title="Page setup" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={() => onSave(null)}>Reset</button><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={() => onSave(s)}>Save</button></>}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="field"><span>Paper size</span><select value={s.size} onChange={set('size')}>{Object.entries(PAPER).map(([k, [w, h, name]]) => <option key={k} value={k}>{name} ({w} × {h} mm)</option>)}</select></label>
          <label className="field"><span>Margins</span><select value={s.margin} onChange={set('margin')}>{Object.entries(MARGINS).map(([k, [, name]]) => <option key={k} value={k}>{name}</option>)}</select></label>
        </div>
        <div className="seg" role="radiogroup" aria-label="Orientation">
          {[['portrait', 'Portrait'], ['landscape', 'Landscape']].map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={s.orientation === k} className={s.orientation === k ? 'on' : ''} onClick={() => setS({ ...s, orientation: k })}>{l}</button>)}
        </div>
        <label className="field"><span>Header (top of every page)</span><input value={s.header} maxLength={200} onChange={set('header')} placeholder="e.g. Acme Trading · Quarterly report" /></label>
        <label className="field"><span>Footer (bottom of every page)</span><input value={s.footer} maxLength={200} onChange={set('footer')} placeholder="e.g. Confidential" /></label>
        <label className="check"><input type="checkbox" checked={s.numbers} onChange={set('numbers')} /> Page numbers in the footer</label>
        <p className="muted small" style={{ margin: 0 }}>Used when printing or saving as PDF, and in the Word download. Everyone editing sees the same.</p>
      </div>
    </Modal>
  );
}

/** Clicking a footnote's number in the text goes to its note. */
function focusFootnote(root, sup) {
  const i = [...root.querySelectorAll('sup[data-footnote]')].indexOf(sup);
  const box = document.getElementById(`footnote-${i + 1}`);
  if (box) { box.scrollIntoView({ block: 'center' }); box.focus?.(); }
}

/** The notes at the end of the document, numbered in order; each can be changed in place. */
function FootnoteList({ editor, readOnly }) {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!editor) return undefined;
    const up = () => redraw((n) => n + 1);
    editor.on('update', up);
    return () => editor.off('update', up);
  }, [editor]);
  const notes = editor ? footnotesOf(editor.state.doc) : [];
  if (!notes.length) return null;
  // The note of footnote n (counted afresh: positions move as the text changes).
  const setNote = (n, note) => {
    const f = footnotesOf(editor.state.doc)[n - 1];
    const node = f && editor.state.doc.nodeAt(f.pos);
    if (node?.type.name === 'footnote' && node.attrs.note !== note) editor.view.dispatch(editor.state.tr.setNodeMarkup(f.pos, undefined, { ...node.attrs, note }));
  };
  return (
    <section className="footnotes" aria-label="Footnotes">
      <ol>
        {notes.map((f) => (
          <li key={f.n}>
            {readOnly ? <span id={`footnote-${f.n}`} tabIndex={-1}>{f.note}</span> : (
              <>
                <NoteBox n={f.n} note={f.note} onChange={(v) => setNote(f.n, v)}
                  onDone={() => { const at = footnotesOf(editor.state.doc)[f.n - 1]; if (at) editor.commands.setTextSelection(at.pos + 1); editor.view.focus(); }} />
                <span className="footnote-print">{f.note}</span>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What changed from an earlier version to now: added words green, removed ones struck through. */
function DocChanges({ before, after }) {
  const diff = useMemo(() => diffDocs(before, after), [before, after]);
  const { added, removed } = changeCount(diff);
  return (
    <div className="paper preview-paper doc-changes">
      <p className="muted small changes-summary">{added || removed ? `Since then: ${added} word${added === 1 ? '' : 's'} added, ${removed} taken out.` : 'No changes to the text since then.'}</p>
      {diff.map((b, i) => {
        const Tag = b.kind === 'heading' ? `h${Math.min(6, b.level || 2)}` : 'p';
        return (
          <Tag key={i} className={`change-${b.change} ${b.kind === 'item' ? 'change-item' : ''}`}>
            {b.parts.map((x, j) => (x.t === 'add' ? <ins key={j}>{x.text}</ins> : x.t === 'del' ? <del key={j}>{x.text}</del> : <span key={j}>{x.text}</span>))}
          </Tag>
        );
      })}
    </div>
  );
}

/** One note's box: what you type stays as typed (the shared copy catches up), others' changes show when you're not in it. */
function NoteBox({ n, note, onChange, onDone }) {
  const ref = useRef(null);
  const [v, setV] = useState(note);
  useEffect(() => { if (document.activeElement !== ref.current) setV(note); }, [note]);
  return (
    <textarea ref={ref} id={`footnote-${n}`} className="footnote-input" rows={1} value={v} placeholder="Write the note…" aria-label={`Footnote ${n}`}
      onChange={(e) => { setV(e.target.value); onChange(e.target.value); }} onBlur={() => setV(note)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onDone(); } }} />
  );
}

/** A read-only document (an earlier version), drawn as the editor draws it. */
function DocPreview({ content, fileId }) {
  const editor = useEditor({
    editable: false,
    content,
    extensions: [
      StarterKit.configure({ link: { openOnClick: true } }), TextAlign.configure({ types: ['heading', 'paragraph'] }),
      CommentMark, DocImage.configure({ docId: fileId }), Table, TableRow, TableHeader, TableCell,
      TextStyle, Color, BackgroundColor, FontFamily, FontSize, LineHeight, TableOfContents, PageBreak, Footnote, Mention, TaskList, TaskItem.configure({ nested: true }),
    ],
  }, [content]);
  return <div className="paper preview-paper"><EditorContent editor={editor} /></div>;
}
