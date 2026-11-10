import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useEditor, EditorContent, Mark } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TabbedDocument, DocTab, addTab, openTab, tabIdOfHash } from './doctabsext.js';
import { DocTabs, useTabs } from './DocTabs.jsx';
import { htmlWithTabTitles, tabsOf } from './doctabs.js';
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
import { useToast, Avatar, Menu, Modal, withDataCheck } from '../../components/ui.jsx';
import { PAPER, MARGINS, DEFAULT_SETUP, WATERMARKS, paperStyle, printCss, columnsOf } from './pagesetup.js';
import { ShareDialog } from '../drive/Drive.jsx';
import { EditorHeader } from '../editorCommon.jsx';
import { CommentsPanel, useComments } from '../comments.jsx';
import AltTextDialog from '../../components/AltTextDialog.jsx';
import DrawPad from '../../components/DrawPad.jsx';
import Icon from '../../components/Icon.jsx';
import { FindReplace } from './findReplace.js';
import { WordCountDialog, WordCounter, counterOn } from './WordCount.jsx';
import { Autocorrect } from './autocorrect.js';
import { Superscript, Subscript } from './scripts.js';
import { Indent } from './indent.js';
import { DocPrefsDialog } from './DocPrefs.jsx';
import { CASES, caseTransaction } from './textcase.js';
import { FindBar } from './FindBar.jsx';
import { Outline, goToHeading } from './Outline.jsx';
import { headingsOf, headingForAnchor } from './outline.js';
import { ActionItemsDialog } from './ActionItems.jsx';
import { TableOfContents, htmlWithContents } from './toc.js';
import { SheetChart } from './sheetchart.jsx';
import { ChartPick } from '../ChartLink.jsx';
import { SignedPrintPage } from './Signatures.jsx';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { PageBreak } from './pagebreak.js';
import { captureFormat, applyFormat, wordAt } from './paintformat.js';
import { Footnote, footnotesOf, htmlWithFootnotes } from './footnote.js';
import { NodeSelection } from '@tiptap/pm/state';
import { LinkDialog } from './LinkDialog.jsx';
import { measureLines } from './linenumbers.js';
import { flushSync } from 'react-dom';
import { BookmarkNode, bookmarksOf, bookmarkIdOf, bookmarkAnchor } from './bookmark.js';
import { Mention, mentionQuery, matchPeople } from './mention.js';
import { DropChip, CHIP_PRESETS, CHIP_COLORS, cleanOptions } from './dropchip.js';
import { DateChip, matchDates, dateText, isDate, isoDay } from './datechip.js';
import { FileChip, matchFiles, fileIcon, fileUrl } from './filechip.js';
import { EmailDraft, matchBlocks } from './emaildraft.jsx';
import { EventDraft } from './eventdraft.jsx';
import { MathInline, mathHtml, mathError, MAX_LATEX } from './math.js';
import { Citation, References, htmlWithReferences } from './citation.js';
import { CITE_FIELDS, cleanSource, inText, sourcesOf, sourceKey } from './cite.js';
import { SYMBOL_GROUPS, findSymbols } from './symbols.js';
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
  addOptions() { return { ...this.parent?.(), docId: null, pictureBase: null }; },
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
      src: `${this.options.pictureBase || `/api/files/${this.options.docId}`}/pictures/${fileId}`, alt, 'data-file': fileId, draggable: 'true',
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
const ZOOMS = [50, 75, 90, 100, 110, 125, 150, 200];

export default function DocEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [file, setFile] = useState(null);
  useEffect(() => {
    get(`/files/${id}?open`).then((f) => { setFile(f); document.title = `${f.name} · Docs`; }).catch((e) => { if (e.status === 404) { navigate(`/access/${id}`, { replace: true }); return; } toast(e.message, 'error'); navigate('/drive'); });
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
  const [bookmarking, setBookmarking] = useState(false);
  const [linking, setLinking] = useState(false); // the link box
  const paperRef = useRef(null);
  const [comparing, setComparing] = useState(null); // null, { step: 'pick' } or { name, content }
  const [sendingItems, setSendingItems] = useState(false);
  // A link to another file in Drive, named after it. If people who can open this document can't
  // open that one, the owner is offered to share it with them (everyone else is told who can't).
  const [linkingFile, setLinkingFile] = useState(false);
  const [chartFrom, setChartFrom] = useState(null); // choosing a chart: { step: 'file' } or { step: 'chart', file }
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
          if (await withDataCheck((more) => put(`/files/${f.id}/shares`, { shares: [...now.map((x) => ({ user_id: x.user_id, role: x.role })), ...gap.people.map((p) => ({ user_id: p.id, role: 'viewer' }))], ...more })) === undefined) return;
          toast(`Shared “${f.name}” with ${names} (can view)`);
        } catch (e) { toast(e.message, 'error'); }
      } } });
    } catch { /* checking is a courtesy */ }
  };
  const [status, setStatus] = useState('connecting');
  const [others, setOthers] = useState([]);
  const readOnly = (file.role === 'viewer' || file.role === 'commenter') || !!file?.locked_at;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
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
  const pastedLinkRef = useRef(null); // a pasted link to a file, made a chip once it's looked up
  const docRef = useRef(null); // this document, for event drafts (attached to the event)
  docRef.current = file ? { id: file.id, name: file.name } : null;
  const [drawing, setDrawing] = useState(null); // { at }: the sketch pad is open, to insert there
  const mentionKeyRef = useRef(null); // the @-picker's keys, while it's open
  const chipKeyRef = useRef(null); // Enter or Space on a selected dropdown chip opens its choices
  const dateKeyRef = useRef(null); // and on a date chip, its calendar
  // Your writing preferences (autocorrect, replacements), read by the editor as you type.
  const prefsRef = useRef({ autocorrect: true, subs: [] });
  const [prefsOpen, setPrefsOpen] = useState(false);
  // How documents are shown for you (kept with your account): the zoom, and spell check's underlines.
  const [look, setLook] = useState({ zoom: 100, spellcheck: true });
  useEffect(() => { get('/doc-prefs').then((p) => { prefsRef.current = p; setLook({ zoom: p.zoom || 100, spellcheck: p.spellcheck !== false }); }).catch(() => {}); }, []);
  const setZoom = (zoom) => { setLook((l) => ({ ...l, zoom })); put('/doc-prefs', { zoom }).then((p) => { prefsRef.current = p; }).catch(() => {}); };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, undoRedo: false, document: false }), // undo is per person, from Collaboration
      TabbedDocument, DocTab, // tabs (doctabs.js)
      Autocorrect.configure({ enabled: () => !!prefsRef.current.autocorrect, subs: () => prefsRef.current.subs }),
      Superscript, Subscript, Indent,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Start typing…' }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({ provider, user: { name: user.name, color: colorFor(user.id), id: user.id } }),
      CommentMark,
      DocImage.configure({ docId: file.id }),
      FindReplace,
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      TextStyle, Color, BackgroundColor, FontFamily, FontSize, LineHeight, TableOfContents, SheetChart,
      SuggestInsert, SuggestDelete, SuggestMode,
      PageBreak, Footnote, BookmarkNode, Mention, DropChip, DateChip, FileChip, EmailDraft, EventDraft.configure({ doc: () => docRef.current }), MathInline, Citation, References, TaskList, TaskItem.configure({ nested: true }), // checklists: everyone sees the ticks live; viewers can't tick
    ],
    editable: !readOnly,
    editorProps: {
      // What screen readers call the page you type in.
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Document text' },
      // A key pressed right after a click (Enter, Backspace…) acts where the click put the cursor,
      // even if the browser hasn't told the editor about the new selection yet.
      handleKeyDown: (view, event) => { view.domObserver?.flush?.(); return mentionKeyRef.current?.(event) || chipKeyRef.current?.(event) || dateKeyRef.current?.(event) || false; },
      // Links open with Ctrl+click while editing, or a plain click when reading; a link to a place in this document goes there.
      handleClick: (view, pos, event) => {
        const a = event.target?.closest?.('a[href]');
        if (a?.classList.contains('doc-filechip')) return false; // opened by its own click, below
        if (!a || !(readOnlyRef.current || event.ctrlKey || event.metaKey)) return false;
        const href = a.getAttribute('href');
        event.preventDefault();
        if (href.startsWith('#')) {
          if (window.location.hash === href) window.dispatchEvent(new HashChangeEvent('hashchange'));
          else window.location.hash = href;
        } else window.open(href, '_blank', 'noopener');
        return true;
      },
      // Pictures pasted or dropped in go to Drive and into the document.
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files || [])].filter((f) => PICTURE_TYPES.test(f.type));
        if (!files.length) {
          // A link to a file here, on its own: it goes in as the link, then becomes the file's chip.
          const text = event.clipboardData?.getData('text/plain') || '', link = fileUrl(text);
          if (!link || !view.state.selection.$from.parent.isTextblock) return false;
          event.preventDefault();
          const url = text.trim(), from = view.state.selection.from;
          view.dispatch(view.state.tr.insertText(url).scrollIntoView());
          pastedLinkRef.current?.(link, from, url);
          return true;
        }
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
  // …and files from Drive whose name has what's typed (looked up as you type, after two letters).
  const [fileQuery, setFileQuery] = useState('');
  const [foundFiles, setFoundFiles] = useState({ q: '', list: [] });
  useEffect(() => {
    const q = fileQuery.trim();
    if (q.length < 2) return undefined;
    let gone = false;
    const t = setTimeout(() => get(`/files?view=search&q=${encodeURIComponent(q)}`).then((list) => { if (!gone) setFoundFiles({ q, list }); }).catch(() => {}), 200);
    return () => { gone = true; clearTimeout(t); };
  }, [fileQuery]);
  useEffect(() => {
    if (!editor || readOnly) return undefined;
    const check = () => {
      const { state, view } = editor;
      const sel = state.selection;
      if (!sel.empty || !sel.$from.parent.isTextblock) { setMention(null); return; }
      const before = sel.$from.parent.textBetween(0, sel.$from.parentOffset, undefined, '\ufffc');
      const m = mentionQuery(before, sel.from);
      setFileQuery(m ? m.query : '');
      const files = m && foundFiles.q && m.query.toLowerCase().startsWith(foundFiles.q.toLowerCase()) ? matchFiles(foundFiles.list, m.query, { exclude: file.id }) : [];
      const list = m ? [...matchDates(m.query), ...matchBlocks(m.query), ...matchPeople(colleagues, m.query), ...files] : []; // @today, @tomorrow, @date, @email, then people, then files
      if (!m || !list.length) { setMention(null); return; }
      const c = view.coordsAtPos(sel.from);
      setMention((old) => ({ ...m, list, left: c.left, top: c.bottom + 4, pick: old && old.from === m.from ? Math.min(old.pick, list.length - 1) : 0 }));
    };
    editor.on('selectionUpdate', check);
    editor.on('update', check);
    if (editor.isFocused) check(); // files found since the last keypress
    return () => { editor.off('selectionUpdate', check); editor.off('update', check); };
  }, [editor, readOnly, colleagues, foundFiles, file.id]);
  const pickMention = async (p) => {
    const m = mention;
    setMention(null);
    if (p.kind === 'block') { // an email or event draft, with the cursor in its body
      const go = editor.chain().focus().deleteRange({ from: m.from, to: editor.state.selection.from });
      (p.id === 'block:event' ? go.insertEventDraft({ date: isoDay() }) : go.insertEmailDraft()).run();
      const $p = editor.state.selection.$from, after = $p.before($p.depth), draft = editor.state.doc.resolve(after).nodeBefore;
      if (/^(emailDraft|eventDraft)$/.test(draft?.type.name || '')) editor.commands.setTextSelection(after - draft.nodeSize + 2);
      return;
    }
    if (p.kind === 'file') {
      editor.chain().focus().deleteRange({ from: m.from, to: editor.state.selection.from }).insertFileChip(p.file).run();
      return;
    }
    if (p.kind === 'date') {
      editor.chain().focus().deleteRange({ from: m.from, to: editor.state.selection.from }).insertDateChip(p.date).run();
      if (p.pick) setTimeout(() => openDate(m.from), 0); // "@date": straight to its calendar
      return;
    }
    editor.chain().focus().deleteRange({ from: m.from, to: editor.state.selection.from })
      .insertContent([{ type: 'mention', attrs: { id: p.id, name: p.name, email: p.username } }, { type: 'text', text: ' ' }]).run();
    try {
      const r = await post(`/files/${file.id}/mention`, { user_id: p.id });
      if (r.notified) toast(`${p.name} was told`);
      else if (r.no_access && r.can_share) {
        toast(`${p.name} can't open this document`, 'info', { duration: 15000, action: { label: 'Share with them', onClick: async () => {
          try {
            const now = await get(`/files/${file.id}/shares`);
            if (await withDataCheck((more) => put(`/files/${file.id}/shares`, { shares: [...now.map((x) => ({ user_id: x.user_id, role: x.role })), { user_id: p.id, role: 'editor' }], ...more })) === undefined) return;
            await post(`/files/${file.id}/mention`, { user_id: p.id });
            toast(`Shared with ${p.name} (can edit), and they were told`);
          } catch (e) { toast(e.message, 'error'); }
        } } });
      } else if (r.no_access) toast(`${p.name} can't open this document. Ask its owner to share it.`, 'info', { duration: 10000 });
    } catch (e) { toast(e.message, 'error'); }
  };
  // Dropdown chips: clicking one (or Enter on it) lists its choices; picking one changes it for everyone.
  const [chipMenu, setChipMenu] = useState(null); // { pos, left, top }
  const [chipEdit, setChipEdit] = useState(null); // { pos } to change a chip's choices, { pos: null } for a new one
  const openChip = (pos) => {
    if (readOnly || editor.state.doc.nodeAt(pos)?.type.name !== 'dropchip') return;
    const r = editor.view.nodeDOM(pos)?.getBoundingClientRect?.();
    if (r) setChipMenu({ pos, left: r.left, top: r.bottom + 4 });
  };
  const nodeAtDom = (el, name) => {
    const at = editor.view.posAtDOM(el, 0);
    return [at, at - 1].find((p) => p >= 0 && editor.state.doc.nodeAt(p)?.type.name === name);
  };
  const chipAt = (el) => nodeAtDom(el, 'dropchip');
  // Equations: { pos } to change one, { pos: null } for a new one. Special characters: the Ω picker.
  const [mathEdit, setMathEdit] = useState(null);
  const [citeEdit, setCiteEdit] = useState(null); // { pos } to change a citation, { pos: null } for a new one
  // Back to the text once a dialog has closed (and given focus back to whatever opened it), so typing goes on there.
  const refocus = () => setTimeout(() => editor?.commands.focus(), 0);
  const [symbols, setSymbols] = useState(false);
  const setChip = (pos, attrs) => {
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name !== 'dropchip') return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
  };
  // Date chips: clicking one (or Enter on it) shows a calendar; the day picked is everyone's.
  const [dateMenu, setDateMenu] = useState(null); // { pos, left, top }
  const openDate = (pos) => {
    if (readOnly || editor.state.doc.nodeAt(pos)?.type.name !== 'datechip') return;
    const r = editor.view.nodeDOM(pos)?.getBoundingClientRect?.();
    if (r) setDateMenu({ pos, left: r.left, top: r.bottom + 4 });
  };
  const setDate = (pos, date) => {
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name === 'datechip' && isDate(date)) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, date }));
  };
  dateKeyRef.current = (e) => {
    const sel = editor?.state.selection;
    if ((e.key === 'Enter' || e.key === ' ') && sel?.node?.type.name === 'datechip') { e.preventDefault(); openDate(sel.from); return true; }
    return false;
  };
  chipKeyRef.current = (e) => {
    const sel = editor?.state.selection;
    if ((e.key === 'Enter' || e.key === ' ') && sel?.node?.type.name === 'dropchip') { e.preventDefault(); openChip(sel.from); return true; }
    return false;
  };
  mentionKeyRef.current = (e) => {
    if (!mention) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { setMention({ ...mention, pick: (mention.pick + (e.key === 'ArrowDown' ? 1 : mention.list.length - 1)) % mention.list.length }); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mention.list[mention.pick]); return true; }
    if (e.key === 'Escape') { setMention(null); return true; }
    return false;
  };

  // Pictures: uploaded next to the document (or to your Drive), then put in at the cursor.
  pastedLinkRef.current = async (link, from, url) => {
    if (link.id === file.id) return; // this document's own link stays a link
    let f;
    try { f = await get(`/files/${encodeURIComponent(link.id)}`); } catch { return; } // can't open it: left as the link
    const to = from + url.length;
    if (!editor || editor.isDestroyed || to > editor.state.doc.content.size || editor.state.doc.textBetween(from, to) !== url) return; // changed meanwhile
    editor.chain().insertContentAt({ from, to }, [{ type: 'filechip', attrs: { id: f.id, name: f.name, kind: f.kind || 'file', mime: f.mime || '' } }]).run();
  };
  addPicturesRef.current = async (files, at) => {
    for (const f of files) {
      if (!PICTURE_TYPES.test(f.type)) { toast('Choose a picture (PNG, JPEG, GIF or WebP)', 'error'); continue; }
      try {
        let up;
        try { up = await uploadFile(f, file.parent_id || null); } catch { up = await uploadFile(f, null); }
        const node = { type: 'image', attrs: { fileId: up.id, alt: f.name.replace(/\.[a-z0-9]+$/i, '') } };
        if (at !== undefined) { editor.chain().focus().insertContentAt(at, node).run(); at = undefined; } else editor.chain().focus().insertContent(node).run();
        // Typing goes on after the picture (left selected, the next key would replace it).
        if (editor.state.selection.node?.type.name === 'image') editor.commands.setTextSelection(editor.state.selection.to);
      } catch (e) { toast(e.message, 'error'); }
    }
  };

  useEffect(() => {
    if (!editor || readOnly) return;
    const focusOnce = (synced) => {
      if (!synced) return;
      provider.off('sync', focusOnce);
      // Opened from a link to a heading: start there instead of at the top.
      const h = window.location.hash && headingForAnchor(headingsOf(editor.state.doc), window.location.hash);
      const tabId = tabIdOfHash(window.location.hash); // opened from a link to a tab
      if (tabId && tabsOf(editor.getJSON()).some((t) => t.id === tabId)) openTab(editor, tabId);
      else if (h) goToHeading(editor, h); else if (!goToBookmark(editor, bookmarkIdOf(window.location.hash))) editor.commands.focus('start');
    };
    if (provider.synced) focusOnce(true); else provider.on('sync', focusOnce);
    return () => provider.off('sync', focusOnce);
  }, [editor, provider, readOnly]);

  function exportHtml() {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(file.name)}</title></head><body>${htmlWithTabTitles(htmlWithFootnotes(htmlWithReferences(htmlWithContents(withoutSuggestionsHtml(editor.getHTML()), editor.state.doc), editor.getJSON())))}</body></html>`;
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
  const [wordCount, setWordCount] = useState(false);
  const [liveCount, setLiveCount] = useState(counterOn);
  // Someone changed the page setup: the paper follows.
  useEffect(() => onLive((m) => { if (m.type === 'page-setup' && m.id === file.id) setFile((f) => ({ ...f, page_setup: m.page_setup })); }), [file.id]);
  // Tabs: the panel shows by itself in a document that has tabs; the ▤ button shows or hides it.
  const { tabs: docTabs } = useTabs(editor);
  const [tabsPanel, setTabsPanel] = useState(null);
  const tabsShown = tabsPanel ?? docTabs.length > 0;
  const [outline, setOutlineState] = useState(() => { try { return localStorage.getItem('nw-doc-outline') === '1'; } catch { return false; } });
  const setOutline = (on) => { setOutlineState(on); try { localStorage.setItem('nw-doc-outline', on ? '1' : '0'); } catch { /* private window */ } };
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && k === 'c') { // Word count, as in Google Docs
        if (document.querySelector('.modal-backdrop')) return;
        e.preventDefault();
        setWordCount(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && k === 'k' && !readOnlyRef.current) { // Insert link, as in Google Docs
        if (document.querySelector('.modal-backdrop')) return;
        e.preventDefault();
        setLinking(true);
        return;
      }
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

  // Opened from a link to a heading (/docs/…#budget): go there once the document's text has arrived.
  useEffect(() => {
    if (!editor || !window.location.hash) return undefined;
    let done = false;
    const tryGo = () => {
      if (done) return;
      const h = headingForAnchor(headingsOf(editor.state.doc), window.location.hash);
      if (h) { done = true; goToHeading(editor, h); }
      else if (goToBookmark(editor, bookmarkIdOf(window.location.hash))) done = true;
    };
    tryGo();
    editor.on('update', tryGo);
    const stop = setTimeout(() => { done = true; }, 15000);
    return () => { editor.off('update', tryGo); clearTimeout(stop); };
  }, [editor]);
  // A link to a place in this same document (Ctrl+click, or the address changed by hand) goes there.
  useEffect(() => {
    if (!editor) return undefined;
    const go = () => {
      const h = headingForAnchor(headingsOf(editor.state.doc), window.location.hash);
      if (h) goToHeading(editor, h); else goToBookmark(editor, bookmarkIdOf(window.location.hash));
    };
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [editor]);
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
          <button type="button" className={`btn small ${tabsShown ? 'primary' : ''}`} aria-pressed={tabsShown} onClick={() => setTabsPanel(!tabsShown)} title="Tabs">
            <span aria-hidden="true">▤</span><span className="sr-only">Tabs</span>
          </button>
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
          ...(!readOnly ? [{ label: 'Page setup', icon: 'print', onClick: () => setPageSetupOpen(true) }, { label: 'Add tab', icon: 'plus', onClick: () => { addTab(editor); setTabsPanel(true); } }] : []),
          { label: 'Version history', icon: 'clock', onClick: () => setHistory(true) },
          { label: 'Compare documents', icon: 'doc', onClick: () => setComparing({ step: 'pick' }) },
          { label: 'Bookmarks', icon: 'link', onClick: () => setBookmarking(true) },
          ...(!readOnly ? [{ label: 'Send action items to Tasks', icon: 'check', onClick: () => setSendingItems(true) }] : []),
          { label: 'Word count', icon: 'doc', onClick: () => setWordCount(true) },
          ...(!readOnly ? [{ label: 'Preferences', icon: 'settings', onClick: () => setPrefsOpen(true) }] : []),
          '-',
          { label: 'Print / Save as PDF', icon: 'print', onClick: () => window.print() },
          { label: 'Download as HTML', icon: 'download', onClick: exportHtml },
          { label: 'Download as Word (.docx)', icon: 'download', onClick: () => { window.location.href = `/api/files/${file.id}/export`; } },
          { label: 'Download as OpenDocument (.odt)', icon: 'download', onClick: () => { window.location.href = `/api/files/${file.id}/export?format=odt`; } },
          { label: 'Download as Markdown (.md)', icon: 'download', onClick: () => { window.location.href = `/api/files/${file.id}/export?format=md`; } },
          { label: 'Download as e-book (.epub)', icon: 'download', onClick: () => { window.location.href = `/api/files/${file.id}/export?format=epub`; } },
        ]}
      />
      {!readOnly && <Toolbar editor={editor} onDropdown={() => setChipEdit({ pos: null })} onEquation={() => setMathEdit({ pos: null })} onCite={() => setCiteEdit({ pos: null })} onSymbols={() => setSymbols(true)} onComment={startComment} onPictures={(files) => addPicturesRef.current(files)} onLinkFile={() => setLinkingFile(true)} onLink={() => setLinking(true)} onChart={() => setChartFrom({ step: 'file' })} onDraw={() => setDrawing({ at: editor.state.selection.from })} />}
      {drawing && <DrawPad title="Drawing" saveLabel="Insert" onClose={() => { setDrawing(null); refocus(); }}
        onSave={(f) => addPicturesRef.current([new File([f], 'Drawing.png', { type: 'image/png' })], drawing.at)} />}
      {chartFrom?.step === 'file' && <DrivePicker title="Chart from a spreadsheet" accept={(x) => x.kind === 'sheet'} empty="No spreadsheets found." onClose={() => setChartFrom(null)} onPick={(f) => setChartFrom({ step: 'chart', file: f })} />}
      {chartFrom?.step === 'chart' && <ChartPick file={chartFrom.file} onClose={() => setChartFrom(null)}
        onPick={(ch) => { const f = chartFrom.file; setChartFrom(null); editor.chain().focus().insertSheetChart({ fileId: f.id, chartId: ch.id, title: ch.now.title, chartType: ch.now.chartType, data: JSON.stringify(ch.now.data) }).run(); }} />}
      {linkingFile && <DrivePicker title="Link to a file in Drive" accept={(x) => x.id !== file.id} empty="No files found." onClose={() => setLinkingFile(false)}
        onPick={(f) => { setLinkingFile(false); linkFile(f); }} />}
      <style>{highlight}</style>
      <style>{printCss(file.page_setup)}</style>
      {status === 'offline' && <div className="banner warn">You're offline. Keep typing: your changes are kept here and sync when the connection is back.</div>}
      {readOnly && <div className="banner">{file.locked_at ? 'Locked.' : file.role === 'commenter' ? 'You can comment, not edit.' : 'View only.'} {!file.locked_at && `Ask ${file.owner_name} for edit access.`}</div>}
      {finding && <FindBar key={finding.n} editor={editor} replacing={finding.replace} canEdit={!readOnly} onClose={() => { editor.view.focus(); setFinding(null); }} />} {/* focus back first, so it doesn't go with the bar */}
      <div className="doc-body">
        {tabsShown && <DocTabs editor={editor} canEdit={!readOnly} fileId={file.id} onCopied={(m) => toast(m)} onClose={() => setTabsPanel(false)} />}
        {outline && <Outline editor={editor} fileId={file.id} onCopied={(m) => toast(m)} onClose={() => setOutline(false)} />}
        {liveCount && <WordCounter editor={editor} onOpen={() => setWordCount(true)} />}
        <label className="doc-zoom" title="Zoom (kept for you, in every document)"><span className="sr-only">Zoom</span>
          <select aria-label="Zoom" value={look.zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {ZOOMS.map((z) => <option key={z} value={z}>{z}%</option>)}
          </select></label>
        <div className="doc-scroll" onClick={(e) => e.target === e.currentTarget && editor.commands.focus('end')}>
          <div ref={paperRef} className={`paper with-tabs ${file.page_setup?.pageless ? 'pageless' : ''} ${columnsOf(file.page_setup) > 1 ? `cols-${columnsOf(file.page_setup)}` : ''} ${file.page_setup?.lineNumbers ? 'line-numbered' : ''} ${file.page_setup?.headingNumbers ? 'heading-numbers' : ''}`} style={{ ...(file.page_setup ? paperStyle(file.page_setup) : {}), ...(look.zoom !== 100 && { zoom: look.zoom / 100 }) }} spellCheck={look.spellcheck}>
            {file.page_setup?.lineNumbers && <LineNumbers editor={editor} paperRef={paperRef} layout={JSON.stringify(file.page_setup)} />}
            {file.page_setup?.watermark && <div className="print-watermark" aria-hidden="true" />}
            {file.page_setup?.watermark && <span className="sr-only">Watermark: {file.page_setup.watermark}</span>}
            {file.page_setup?.header && <div className="paper-header" aria-hidden="true">{file.page_setup.header}</div>}
            <EditorContent editor={editor} onClick={(e) => {
              const sup = e.target.closest?.('sup[data-footnote]'); if (sup) focusFootnote(e.currentTarget, sup);
              const fc = e.target.closest?.('a.doc-filechip'); if (fc) { e.preventDefault(); window.open(fc.getAttribute('href'), '_blank', 'noopener'); } // a file chip opens the file with a click
              const chip = e.target.closest?.('[data-dropchip]'); if (chip) { const at = chipAt(chip); if (at != null) openChip(at); }
              const day = e.target.closest?.('.doc-date'); if (day) { const at = nodeAtDom(day, 'datechip'); if (at != null) openDate(at); }
              const ct = e.target.closest?.('[data-cite]'); if (ct && !readOnly) { const at = nodeAtDom(ct, 'citation'); if (at != null) setCiteEdit({ pos: at }); }
              const eq = e.target.closest?.('[data-math]'); if (eq && !readOnly) { const at = nodeAtDom(eq, 'math'); if (at != null) setMathEdit({ pos: at }); }
            }} />
            {chipMenu && <ChipMenu node={editor.state.doc.nodeAt(chipMenu.pos)} at={chipMenu} onClose={() => { setChipMenu(null); editor.view.focus(); }}
              onPick={(value) => { setChip(chipMenu.pos, { value }); setChipMenu(null); const after = chipMenu.pos + 1; editor.chain().focus().setTextSelection(after + (editor.state.doc.textBetween(after, Math.min(after + 1, editor.state.doc.content.size)) === ' ' ? 1 : 0)).run(); }}
              onEdit={() => { setChipEdit({ pos: chipMenu.pos }); setChipMenu(null); }} />}
            {dateMenu && <DateMenu node={editor.state.doc.nodeAt(dateMenu.pos)} at={dateMenu}
              onPick={(date) => setDate(dateMenu.pos, date)}
              onClose={() => {
                const after = dateMenu.pos + 1, size = editor.state.doc.content.size; // after the chip and its space
                setDateMenu(null);
                editor.chain().focus().setTextSelection(Math.min(size, after + (editor.state.doc.textBetween(after, Math.min(after + 1, size)) === ' ' ? 1 : 0))).run();
              }} />}
            {mention && (
              <ul className="mention-list doc-mention-list" role="listbox" aria-label="People, dates and files" style={{ position: 'fixed', left: mention.left, top: mention.top }}>
                {mention.list.map((p, i) => (p.kind === 'block' ? (
                  <li key={p.id} role="option" aria-selected={i === mention.pick} className={i === mention.pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}>
                    <span aria-hidden="true" style={{ width: 20, textAlign: 'center' }}>{p.id === 'block:event' ? '📅' : '✉'}</span> {p.label} <span className="muted small">Building block</span>
                  </li>
                ) : p.kind === 'file' ? (
                  <li key={p.id} role="option" aria-selected={i === mention.pick} className={i === mention.pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}>
                    <span aria-hidden="true" style={{ width: 20, textAlign: 'center' }}>{fileIcon(p.file.kind, p.file.mime, p.file.name)}</span> {p.file.name} <span className="muted small">{p.file.kind === 'folder' ? 'Folder' : 'File'}</span>
                  </li>
                ) : p.kind === 'date' ? (
                  <li key={p.id} role="option" aria-selected={i === mention.pick} className={i === mention.pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}>
                    <Icon name="calendar" size={20} /> {p.label} {!p.pick && <span className="muted small">{dateText(p.date)}</span>}
                  </li>
                ) : (
                  <li key={p.id} role="option" aria-selected={i === mention.pick} className={i === mention.pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}>
                    <Avatar name={p.name} size={20} userId={p.id} /> {p.name} <span className="muted small">{p.username}</span>
                  </li>
                )))}
              </ul>
            )}
            <FootnoteList editor={editor} readOnly={readOnly} />
            <SignedPrintPage fileId={file.id} />
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
      {comparing?.step === 'pick' && <DrivePicker title="Compare with…" empty="No documents found."
        accept={(x) => x.id !== file.id && (x.kind === 'doc' || (x.kind === 'file' && /\.(docx|odt|md|markdown)$/i.test(x.name)))}
        onClose={() => { setComparing(null); refocus(); }}
        onPick={async (f) => {
          setComparing({ step: 'loading' });
          try { setComparing(await get(`/files/${f.id}/as-doc`)); } catch (e) { setComparing(null); toast(e.message, 'error'); }
        }} />}
      {linking && <LinkDialog editor={editor} onClose={() => { setLinking(false); refocus(); }} />}
      {bookmarking && <BookmarksDialog editor={editor} canEdit={!readOnly} onClose={() => { setBookmarking(false); refocus(); }} />}
      {comparing?.content && <CompareDialog name={file.name} other={comparing} current={editor.getJSON()} onClose={() => { setComparing(null); refocus(); }} />}
      {sendingItems && <ActionItemsDialog fileId={file.id} doc={editor.getJSON()} onClose={() => setSendingItems(false)} />}
      {history && <VersionHistory file={file} canEdit={!readOnly} onClose={() => setHistory(false)} renderPreview={(content) => <DocPreview content={content} fileId={file.id} />} renderChanges={(content) => <DocChanges before={content} after={editor.getJSON()} />} />}
      {citeEdit && <CiteDialog source={citeEdit.pos != null ? editor.state.doc.nodeAt(citeEdit.pos)?.attrs : null} known={sourcesOf(editor.getJSON())}
        onClose={() => { setCiteEdit(null); refocus(); }}
        onRemove={citeEdit.pos != null ? () => { const at = citeEdit.pos; setCiteEdit(null); editor.chain().deleteRange({ from: at, to: at + 1 }).run(); refocus(); } : null}
        onSave={(src) => {
          const at = citeEdit.pos;
          setCiteEdit(null);
          if (at != null && editor.state.doc.nodeAt(at)?.type.name === 'citation') { editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, cleanSource(src))); editor.commands.setTextSelection(at + 1); }
          else editor.chain().insertCitation(src).run();
          refocus();
        }} />}
      {mathEdit && <MathDialog latex={mathEdit.pos != null ? editor.state.doc.nodeAt(mathEdit.pos)?.attrs.latex : ''}
        onClose={() => { setMathEdit(null); refocus(); }}
        onRemove={mathEdit.pos != null ? () => { const at = mathEdit.pos; setMathEdit(null); editor.chain().focus().deleteRange({ from: at, to: at + 1 }).run(); } : null}
        onSave={(latex) => {
          const at = mathEdit.pos;
          setMathEdit(null);
          if (at != null && editor.state.doc.nodeAt(at)?.type.name === 'math') { editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { latex })); editor.chain().focus().setTextSelection(at + 1).run(); }
          else editor.chain().focus().insertMath(latex).run();
        }} />}
      {symbols && <SymbolDialog onClose={() => { setSymbols(false); editor.view.focus(); }} onPick={(ch) => { editor.chain().focus().insertContent(ch).run(); }} />}
      {chipEdit && <ChipDialog options={chipEdit.pos != null ? editor.state.doc.nodeAt(chipEdit.pos)?.attrs.options : null}
        onClose={() => { setChipEdit(null); refocus(); }}
        onSave={(options) => {
          if (chipEdit.pos != null) {
            const node = editor.state.doc.nodeAt(chipEdit.pos);
            setChip(chipEdit.pos, { options, value: options.some((o) => o.label === node?.attrs.value) ? node.attrs.value : null });
          } else editor.chain().insertDropChip(options).run();
          setChipEdit(null);
          refocus();
        }} />}
      {prefsOpen && <DocPrefsDialog prefs={prefsRef.current} onSaved={(p) => { prefsRef.current = p; setLook({ zoom: p.zoom || 100, spellcheck: p.spellcheck !== false }); }} onClose={() => { setPrefsOpen(false); editor.view.focus(); }} />}
      {wordCount && <WordCountDialog editor={editor} live={liveCount} onLive={setLiveCount} onClose={() => { setWordCount(false); editor.view.focus(); }} />}
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

function Toolbar({ editor, onDropdown, onEquation, onCite, onSymbols, onComment, onPictures, onLinkFile, onLink, onChart, onDraw }) {
  const [altEdit, setAltEdit] = useState(null); // { pos, alt } of the picture being described
  const pictureInput = useRef();
  const [, force] = useState(0);
  const [open, setOpen] = useState(false); // phones: the toolbar folds away behind one button
  useEffect(() => {
    const f = () => force((n) => n + 1);
    editor.on('selectionUpdate', f);
    editor.on('transaction', f);
    return () => { editor.off('selectionUpdate', f); editor.off('transaction', f); };
  }, [editor]);

  // Paint format: { fmt, sticky } while the brush is on (one use, or until Esc after a double-click).
  const [painter, setPainter] = useState(null);
  useEffect(() => {
    if (!painter) return undefined;
    const dom = editor.view.dom;
    dom.classList.add('painting');
    const up = () => setTimeout(() => {
      const { state } = editor;
      const { from, to, empty } = state.selection;
      const range = empty ? wordAt(state.doc, from) : { from, to };
      if (!range) return;
      editor.view.dispatch(applyFormat(state, painter.fmt, range.from, range.to));
      if (!painter.sticky) setPainter(null);
    }, 0);
    const esc = (e) => { if (e.key === 'Escape') setPainter(null); };
    dom.addEventListener('mouseup', up);
    window.addEventListener('keydown', esc);
    return () => { dom.classList.remove('painting'); dom.removeEventListener('mouseup', up); window.removeEventListener('keydown', esc); };
  }, [painter, editor]);

  const c = () => editor.chain().focus();
  const B = ({ label, title, active, onClick, className = '' }) => (
    <button type="button" className={`tb ${active ? 'on' : ''} ${className}`} title={title} aria-label={title} aria-pressed={!!active}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{label}</button>
  );
  const block = editor.isActive('heading', { level: 1 }) ? 'h1' : editor.isActive('heading', { level: 2 }) ? 'h2'
    : editor.isActive('heading', { level: 3 }) ? 'h3' : 'p';

  return (
    <div className={`toolbar foldable ${open ? 'open' : ''}`} role="toolbar" aria-label="Formatting">
      <button type="button" className="tb tb-fold" aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>{open ? 'Hide formatting ▴' : 'Formatting ▾'}</button>
      {altEdit && <AltTextDialog value={altEdit.alt} onClose={() => { setAltEdit(null); editor.commands.focus(); }} onSave={(alt) => {
        const node = editor.state.doc.nodeAt(altEdit.pos);
        if (node?.type.name === 'image') editor.view.dispatch(editor.state.tr.setNodeMarkup(altEdit.pos, undefined, { ...node.attrs, alt }));
        setAltEdit(null); editor.commands.focus();
      }} />}
      <B label="↶" title="Undo (Ctrl+Z)" onClick={() => c().undo().run()} />
      <B label="↷" title="Redo (Ctrl+Y)" onClick={() => c().redo().run()} />
      <button type="button" className={`tb ${painter ? 'on' : ''}`} aria-label="Paint format" aria-pressed={!!painter}
        title={painter?.sticky ? 'Paint format is on: select text to give it this formatting (Esc to stop)' : 'Paint format: copy this formatting, then select or click text to apply it (double-click to keep it on)'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { if (e.detail > 1) return; setPainter((p) => (p ? null : { fmt: captureFormat(editor.state), sticky: false })); }}
        onDoubleClick={() => setPainter({ fmt: captureFormat(editor.state), sticky: true })}>🖌</button>
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
          <select aria-label="Capitalisation" title="Capitalisation of the selected text" value="" disabled={editor.state.selection.empty}
            onChange={(e) => { const tr = e.target.value && caseTransaction(editor.state, e.target.value); if (tr) editor.view.dispatch(tr); editor.view.focus(); }}>
            <option value="">Aa</option>
            {CASES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select>
        </>;
      })()}
      <span className="sep" />
      <B label={<b>B</b>} title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => c().toggleBold().run()} />
      <B label={<i>I</i>} title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => c().toggleItalic().run()} />
      <B label={<u>U</u>} title="Underline (Ctrl+U)" active={editor.isActive('underline')} onClick={() => c().toggleUnderline().run()} />
      <B label={<s>S</s>} title="Strikethrough" active={editor.isActive('strike')} onClick={() => c().toggleStrike().run()} />
      <B label={<span>x<sup>2</sup></span>} title="Superscript (Ctrl+.)" active={editor.isActive('superscript')} onClick={() => c().toggleMark('superscript').run()} />
      <B label={<span>x<sub>2</sub></span>} title="Subscript (Ctrl+,)" active={editor.isActive('subscript')} onClick={() => c().toggleMark('subscript').run()} />
      <B label="⇤" title="Decrease indent (Ctrl+[)" onClick={() => c().decreaseIndent().run()} />
      <B label="⇥" title="Increase indent (Ctrl+])" onClick={() => c().increaseIndent().run()} />
      <B label="</>" title="Inline code" active={editor.isActive('code')} onClick={() => c().toggleCode().run()} />
      <B label="🔗" title="Link (Ctrl+K)" active={editor.isActive('link')} onClick={onLink} />
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
      <button type="button" className="tb labelled" title="Drawing: sketch a diagram with lines, arrows, boxes and ellipses, put in as a picture" aria-label="Insert drawing" onMouseDown={(e) => e.preventDefault()} onClick={onDraw}>✎ Drawing</button>
      <input ref={pictureInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { onPictures([...e.target.files]); e.target.value = ''; }} />
      {editor.isActive('image') && <>
        <select className="tb-select" aria-label="Picture size" value={editor.getAttributes('image').width || ''} onChange={(e) => c().updateAttributes('image', { width: e.target.value || null }).run()}>
          {PICTURE_SIZES.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
        </select>
        {[['left', 'Picture on the left', '⯇'], ['center', 'Picture in the centre', '≡'], ['right', 'Picture on the right', '⯈']].map(([a, t, g]) => (
          <B key={a} label={g} title={t} active={(editor.getAttributes('image').align || 'left') === a} onClick={() => c().updateAttributes('image', { align: a === 'left' ? null : a }).run()} />
        ))}
        <button type="button" className="tb labelled" aria-label="Alt text" title={editor.getAttributes('image').alt ? `Alt text: ${editor.getAttributes('image').alt}` : 'Describe the picture for screen readers'}
          onMouseDown={(e) => e.preventDefault()} onClick={() => setAltEdit({ pos: editor.state.selection.from, alt: editor.getAttributes('image').alt })}>Alt text</button>
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
      <button type="button" className="tb labelled" title="Equation: write it in LaTeX, such as \frac{a}{b} or x^2 (or type $$…$$ in the text)" aria-label="Insert equation"
        onMouseDown={(e) => e.preventDefault()} onClick={onEquation}>∑ Equation</button>
      <Menu align="left" trigger={(p) => <button type="button" className="tb labelled" title="Cite a source (APA style), and list the sources in a References section" aria-label="Citations" onMouseDown={(e) => e.preventDefault()} {...p}>❝ Cite</button>} items={[
        { label: 'Cite a source…', onClick: onCite },
        { label: 'Insert references list', onClick: () => c().insertReferences().run(), disabled: (() => { let has = false; editor.state.doc.descendants((n) => { if (n.type.name === 'references') has = true; }); return has; })() },
      ]} />
      <button type="button" className="tb" title="Special characters: dashes, symbols, currencies, arrows, Greek and accented letters" aria-label="Insert special character"
        onMouseDown={(e) => e.preventDefault()} onClick={onSymbols}>Ω</button>
      <Menu align="left" trigger={(p) => <button type="button" className="tb labelled" title="Dropdown: a coloured choice in the text (status, review, priority…) that anyone editing changes with a click" aria-label="Insert dropdown" onMouseDown={(e) => e.preventDefault()} {...p}>▾ Dropdown</button>} items={[
        ...CHIP_PRESETS.map((p) => ({ label: `${p.name}: ${p.options.map((o) => o.label).join(', ')}`, onClick: () => c().insertDropChip(p.options).run() })),
        '-',
        { label: 'Your own choices…', onClick: onDropdown },
      ]} />
      <button type="button" className="tb labelled" title="Date: today's date as a chip; click it to pick another day (or type @today, @tomorrow or @date)" aria-label="Insert date"
        onMouseDown={(e) => e.preventDefault()} onClick={() => c().insertDateChip(isoDay()).run()}><Icon name="calendar" size={18} /> Date</button>
      <button type="button" className="tb labelled" title="Page break: what follows starts a new page when printed or downloaded (Ctrl+Enter)" aria-label="Insert page break"
        onMouseDown={(e) => e.preventDefault()} onClick={() => c().setPageBreak().run()}>⤓ Page break</button>
      <button type="button" className="tb labelled" title="Footnote: a numbered note at the end of the document, for a source or an aside" aria-label="Insert footnote"
        onMouseDown={(e) => e.preventDefault()} onClick={() => c().insertFootnote().run()}><sup>1</sup> Footnote</button>
      <button type="button" className="tb labelled" title="Insert a table of contents: the document's headings, kept up to date, each a link" aria-label="Insert table of contents"
        onMouseDown={(e) => e.preventDefault()} onClick={() => c().insertTableOfContents().run()}><Icon name="menu" size={18} /> Contents</button>
      <button type="button" className="tb labelled" title="A chart from one of your spreadsheets (it can be updated when the spreadsheet changes)" aria-label="Insert chart from Sheets"
        onMouseDown={(e) => e.preventDefault()} onClick={onChart}><Icon name="chart" size={18} /> Chart</button>
      <span className="sep" />
      <button type="button" className="tb labelled" title="Comment on the selected text (Ctrl+Alt+M)" aria-label="Add comment" disabled={editor.state.selection.empty}
        onMouseDown={(e) => e.preventDefault()} onClick={onComment}><Icon name="chat" size={18} /> Comment</button>
    </div>
  );
}

function TableGlyph() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4h18v16H3V4zm2 2v3h6V6H5zm8 0v3h6V6h-6zm-8 5v3h6v-3H5zm8 0v3h6v-3h-6zm-8 5v2h6v-2H5zm8 0v2h6v-2h-6z" /></svg>;
}

const CITE_LABELS = { author: 'Author(s)', year: 'Year', title: 'Title', publisher: 'Publisher or website', url: 'Web address (optional)' };
/** A source to cite: one already cited in the document, or a new one. */
function CiteDialog({ source, known, onSave, onRemove, onClose }) {
  const [s, setS] = useState(() => ({ ...cleanSource(source || {}) }));
  const ready = (s.author || s.title) && s.title;
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  return (
    <Modal title={source ? 'Change citation' : 'Cite a source'} onClose={onClose}
      footer={<>{onRemove && <button type="button" className="btn danger" onClick={onRemove}>Remove</button>}<span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!ready} onClick={() => onSave(cleanSource(s))}>{source ? 'Save' : 'Insert'}</button></>}>
      <div className="stack">
        {!source && known.length > 0 && (
          <label className="field"><span>A source already cited</span>
            <select value="" onChange={(e) => { const k = known.find((x) => sourceKey(x) === e.target.value); if (k) setS({ ...k }); }}>
              <option value="">Choose one, or fill in a new one below</option>
              {known.map((k) => <option key={sourceKey(k)} value={sourceKey(k)}>{inText(k)} {k.title}</option>)}
            </select>
          </label>
        )}
        {CITE_FIELDS.map((k) => (
          <label key={k} className="field"><span>{CITE_LABELS[k]}</span>
            <input value={s[k]} onChange={set(k)} inputMode={k === 'year' ? 'numeric' : undefined} type={k === 'url' ? 'url' : 'text'}
              placeholder={{ author: 'Smith, J. & Lee, K. (separate people with & or ;)', year: '2024', title: 'The title of the book, article or page', publisher: '', url: 'https://' }[k]} />
          </label>
        ))}
        <p className="muted small" style={{ margin: 0 }}>In the text: <strong>{inText(s)}</strong>. Insert a references list from the ❝ Cite menu to list every source, APA style.</p>
      </div>
    </Modal>
  );
}

/** Writing an equation in LaTeX, with how it looks as you type. */
function MathDialog({ latex, onSave, onRemove, onClose }) {
  const [v, setV] = useState(latex || '');
  const error = v.trim() ? mathError(v) : null;
  const EXAMPLES = [['Fraction', '\\frac{a}{b}'], ['Power', 'x^{2}'], ['Root', '\\sqrt{x}'], ['Sum', '\\sum_{i=1}^{n} i'], ['Integral', '\\int_{0}^{1} f(x)\\,dx'], ['Greek', '\\alpha + \\beta']];
  return (
    <Modal title={latex ? 'Change equation' : 'New equation'} onClose={onClose}
      footer={<>{onRemove && <button type="button" className="btn danger" onClick={onRemove}>Remove</button>}<span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!v.trim() || !!error} onClick={() => onSave(v.trim().slice(0, MAX_LATEX))}>{latex ? 'Save' : 'Insert'}</button></>}>
      <div className="stack">
        <label className="field"><span>LaTeX</span>
          <textarea autoFocus rows={3} maxLength={MAX_LATEX} value={v} spellCheck={false} className="mono" placeholder="e.g. \frac{-b \pm \sqrt{b^2-4ac}}{2a}" onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && v.trim() && !error) onSave(v.trim()); }} />
        </label>
        <div className="row wrap" style={{ gap: 6 }}>{EXAMPLES.map(([n, x]) => <button key={n} type="button" className="btn small" onClick={() => setV((cur) => `${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}${x}`)}>{n}</button>)}</div>
        <div className="math-preview" role="img" aria-label="Preview" dangerouslySetInnerHTML={{ __html: v.trim() ? mathHtml(v, true) : '<span class="muted">The equation shows here.</span>' }} />
        {error && <p className="error small" role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
    </Modal>
  );
}

/** Special characters to put in at the cursor: search by name, or browse the groups. */
function SymbolDialog({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const found = findSymbols(q);
  const groups = SYMBOL_GROUPS.map(([g]) => [g, found.filter((s) => s.group === g)]).filter(([, l]) => l.length);
  return (
    <Modal title="Special characters" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <div className="stack">
        <input autoFocus type="search" aria-label="Search characters" placeholder="Search: dash, euro, arrow, alpha…" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && found[0]) { e.preventDefault(); onPick(found[0].ch); } }} />
        <div className="symbol-groups">
          {groups.map(([g, list]) => (
            <section key={g} aria-label={g}><h3 className="small muted">{g}</h3>
              <div className="symbol-grid">{list.map((s) => <button key={s.ch} type="button" className="symbol" title={s.name} aria-label={s.name} onClick={() => onPick(s.ch)}>{s.ch}</button>)}</div>
            </section>
          ))}
          {!groups.length && <p className="muted">No characters match.</p>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Click a character to put it in where the cursor is; the window stays open for more.</p>
      </div>
    </Modal>
  );
}

/** A date chip's calendar, under the chip: another day, or today or tomorrow in one click. */
function DateMenu({ node, at, onPick, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('input')?.focus();
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  if (!node || node.type.name !== 'datechip') return null;
  return (
    <div ref={ref} className="chip-menu date-menu" role="dialog" aria-label="Change the date" style={{ position: 'fixed', left: at.left, top: at.top }}
      onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && e.target.tagName === 'INPUT')) { e.preventDefault(); onClose(); } }}>
      <label className="field"><span>Date</span><input type="date" defaultValue={node.attrs.date || ''} onChange={(e) => onPick(e.target.value)} /></label>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn small" onClick={() => { onPick(isoDay()); onClose(); }}>Today</button>
        <button type="button" className="btn small" onClick={() => { onPick(isoDay(new Date(), 1)); onClose(); }}>Tomorrow</button>
        <span className="grow" />
        <button type="button" className="btn small primary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** A dropdown chip's choices, under the chip. */
function ChipMenu({ node, at, onPick, onEdit, onClose }) {
  const ref = useRef(null);
  const options = node?.attrs.options || [];
  const [pick, setPick] = useState(() => Math.max(0, options.findIndex((o) => o.label === node?.attrs.value)));
  useEffect(() => {
    ref.current?.focus();
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);
  if (!node || node.type.name !== 'dropchip') return null;
  const keys = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPick((pick + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[pick]) onPick(options[pick].label); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  return (
    <div ref={ref} className="chip-menu" role="listbox" tabIndex={-1} aria-label="Choices" onKeyDown={keys} style={{ position: 'fixed', left: at.left, top: at.top }}>
      {options.map((o, i) => (
        <button key={o.label} type="button" role="option" aria-selected={o.label === node.attrs.value} className={`chip-opt${i === pick ? ' on' : ''}`} onClick={() => onPick(o.label)}>
          <span className={`doc-chip chip-${o.color}`}>{o.label}</span>{o.label === node.attrs.value && <span aria-hidden="true">✓</span>}
        </button>
      ))}
      <hr />
      {node.attrs.value && <button type="button" className="chip-opt" onClick={() => onPick(null)}>Clear the choice</button>}
      <button type="button" className="chip-opt" onClick={onEdit}>Change the choices…</button>
    </div>
  );
}

/** Typing a dropdown's choices, one per line, each with a colour. */
function ChipDialog({ options, onSave, onClose }) {
  const [rows, setRows] = useState(() => (options?.length ? options : [{ label: '', color: 'grey' }, { label: '', color: 'blue' }]).map((o) => ({ ...o })));
  const clean = cleanOptions(rows);
  const set = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Modal title={options ? 'Change the choices' : 'New dropdown'} onClose={onClose}
      footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={clean.length < 1} onClick={() => onSave(clean)}>{options ? 'Save' : 'Insert'}</button></>}>
      <div className="stack">
        {rows.map((r, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <input aria-label={`Choice ${i + 1}`} value={r.label} maxLength={40} placeholder={`Choice ${i + 1}`} className="grow" onChange={(e) => set(i, 'label', e.target.value)} />
            <select aria-label={`Colour of choice ${i + 1}`} value={r.color} onChange={(e) => set(i, 'color', e.target.value)}>
              {CHIP_COLORS.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
            </select>
            <button type="button" className="icon-btn" aria-label={`Remove choice ${i + 1}`} disabled={rows.length < 2} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>
          </div>
        ))}
        {rows.length < 12 && <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setRows([...rows, { label: '', color: CHIP_COLORS[rows.length % CHIP_COLORS.length] }])}>Add a choice</button>}
        <p className="muted small" style={{ margin: 0 }}>Anyone who can edit the document picks one with a click. Choices that are no longer there are cleared.</p>
      </div>
    </Modal>
  );
}

/** Paper size, orientation, margins, and a header and footer for printing and Word. */
function PageSetupDialog({ setup, onClose, onSave }) {
  const [s, setS] = useState({ ...DEFAULT_SETUP, ...(setup || {}) });
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title="Page setup" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={() => onSave(null)}>Reset</button><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={() => onSave(s)}>Save</button></>}>
      <div className="stack">
        <div className="seg" role="radiogroup" aria-label="Format">
          {[[false, 'Pages'], [true, 'Pageless']].map(([k, l]) => <button key={l} type="button" role="radio" aria-checked={!!s.pageless === k} className={!!s.pageless === k ? 'on' : ''} onClick={() => setS({ ...s, pageless: k })}>{l}</button>)}
        </div>
        {s.pageless && <p className="muted small" style={{ margin: 0 }}>On screen the document is one long sheet as wide as the window: good for wide tables and pictures. Printing, PDF and Word still use the paper below.</p>}
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="field"><span>Paper size</span><select value={s.size} onChange={set('size')}>{Object.entries(PAPER).map(([k, [w, h, name]]) => <option key={k} value={k}>{name} ({w} × {h} mm)</option>)}</select></label>
          <label className="field"><span>Margins</span><select value={s.margin} onChange={set('margin')}>{Object.entries(MARGINS).map(([k, [, name]]) => <option key={k} value={k}>{name}</option>)}</select></label>
        </div>
        <div className="seg" role="radiogroup" aria-label="Orientation">
          {[['portrait', 'Portrait'], ['landscape', 'Landscape']].map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={s.orientation === k} className={s.orientation === k ? 'on' : ''} onClick={() => setS({ ...s, orientation: k })}>{l}</button>)}
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="small">Columns</span>
          <div className="seg" role="radiogroup" aria-label="Columns">
            {[[1, 'One'], [2, 'Two'], [3, 'Three']].map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={columnsOf(s) === k} className={columnsOf(s) === k ? 'on' : ''} onClick={() => setS({ ...s, columns: k })}>{l}</button>)}
          </div>
        </div>
        <label className="field"><span>Header (top of every page)</span><input value={s.header} maxLength={200} onChange={set('header')} placeholder="e.g. Acme Trading · Quarterly report" /></label>
        <label className="field"><span>Footer (bottom of every page)</span><input value={s.footer} maxLength={200} onChange={set('footer')} placeholder="e.g. Confidential" /></label>
        <label className="check"><input type="checkbox" checked={s.numbers} onChange={set('numbers')} /> Page numbers in the footer</label>
        <label className="check"><input type="checkbox" checked={!!s.lineNumbers} onChange={set('lineNumbers')} /> Line numbers in the margin</label>
        <label className="check"><input type="checkbox" checked={!!s.headingNumbers} onChange={set('headingNumbers')} /> Number the headings (1, 1.1, 1.1.1)</label>
        <label className="field"><span>Watermark (faint, across every page)</span>
          <input value={s.watermark || ''} maxLength={40} list="watermark-choices" onChange={set('watermark')} placeholder="None, or e.g. DRAFT or CONFIDENTIAL" />
          <datalist id="watermark-choices">{WATERMARKS.map((w) => <option key={w} value={w} />)}</datalist>
        </label>
        <p className="muted small" style={{ margin: 0 }}>Used when printing or saving as PDF, and in the Word download. Everyone editing sees the same.</p>
      </div>
    </Modal>
  );
}

/** Line numbers down the margin: every line of text, measured as laid out (again as the text, the window or the printed page changes). */
function LineNumbers({ editor, paperRef, layout }) {
  const [lines, setLines] = useState([]);
  useEffect(() => {
    if (!editor) return undefined;
    let frame = 0;
    const now = () => { const box = paperRef.current; if (box) flushSync(() => setLines(measureLines(editor.view.dom, box))); };
    const soon = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(now); };
    soon();
    editor.on('update', soon);
    const ro = new ResizeObserver(soon);
    ro.observe(editor.view.dom);
    const print = window.matchMedia('print');
    print.addEventListener('change', now); // straight away: the printed page is laid out next
    window.addEventListener('beforeprint', now);
    window.addEventListener('afterprint', soon);
    return () => {
      cancelAnimationFrame(frame); editor.off('update', soon); ro.disconnect();
      print.removeEventListener('change', now); window.removeEventListener('beforeprint', now); window.removeEventListener('afterprint', soon);
    };
  }, [editor, paperRef, layout]);
  return (
    <div className="line-numbers" aria-hidden="true">
      {lines.map((l) => <span key={l.n} style={{ top: l.top, left: l.left - 40, height: l.height, lineHeight: `${l.height}px` }}>{l.n}</span>)}
    </div>
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

const words = (n) => `${n} word${n === 1 ? '' : 's'}`;

/** What changed from an earlier version to now: added words green, removed ones struck through. */
function DocChanges({ before, after, summary = (added, removed) => (added || removed ? `Since then: ${words(added)} added, ${removed} taken out.` : 'No changes to the text since then.') }) {
  const diff = useMemo(() => diffDocs(before, after), [before, after]);
  const { added, removed } = changeCount(diff);
  return (
    <div className="paper preview-paper doc-changes">
      <p className="muted small changes-summary" role="status">{summary(added, removed)}</p>
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

/** Go to a bookmark (by id): it's chosen and scrolled into view. False when the document has none by that id. */
function goToBookmark(editor, id) {
  const b = id && bookmarksOf(editor.state.doc).find((x) => x.id === id);
  if (!b) return false;
  const { view } = editor;
  if (editor.isEditable) { view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, b.pos))); view.focus(); }
  const el = view.nodeDOM(b.pos);
  if (el?.scrollIntoView) requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }));
  return true;
}

const bookmarkLink = (id) => `${window.location.origin}${window.location.pathname}#${bookmarkAnchor(id)}`;

/** Bookmarks: add one where the cursor is (its link is copied), and go to, copy a link to, or remove the others. */
function BookmarksDialog({ editor, canEdit, onClose }) {
  const toast = useToast();
  const at = useRef(editor.state.selection.from);
  const [, refresh] = useState(0);
  useEffect(() => { const f = () => refresh((n) => n + 1); editor.on('update', f); return () => editor.off('update', f); }, [editor]);
  const marks = bookmarksOf(editor.state.doc);
  const copy = async (id, done) => {
    const url = bookmarkLink(id);
    try { await navigator.clipboard.writeText(url); toast(done || 'Link to the bookmark copied'); } catch { window.prompt('Copy this link', url); }
  };
  const add = () => {
    let id = null;
    editor.chain().setTextSelection(Math.min(at.current, editor.state.doc.content.size - 1)).command(({ tr, commands }) => { const ok = commands.insertBookmark(); id = tr.getMeta('bookmark'); return ok; }).run();
    if (id) copy(id, 'Bookmark added: link copied');
  };
  const remove = (id) => {
    const b = bookmarksOf(editor.state.doc).find((x) => x.id === id);
    if (b) editor.view.dispatch(editor.state.tr.delete(b.pos, b.pos + 1));
  };
  return (
    <Modal title="Bookmarks" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      <p className="muted small">A bookmark marks a place in the document. Its link opens the document right there, for anyone who can open it.</p>
      {canEdit && <p><button type="button" className="btn" onClick={add}>+ Add a bookmark where the cursor is</button></p>}
      {!marks.length ? <p className="muted">No bookmarks yet.</p> : (
        <ul className="bookmark-list" aria-label="Bookmarks in this document">
          {marks.map((b, i) => (
            <li key={b.id} className="row">
              <span className="grow bookmark-text">🔖 {b.text || <span className="muted">(an empty line)</span>}</span>
              <button type="button" className="btn small" aria-label={`Go to bookmark ${i + 1}`} onClick={() => { onClose(); setTimeout(() => goToBookmark(editor, b.id), 0); }}>Go to</button>
              <button type="button" className="btn small" aria-label={`Copy link to bookmark ${i + 1}`} onClick={() => copy(b.id)}>Copy link</button>
              {canEdit && <button type="button" className="btn small" aria-label={`Remove bookmark ${i + 1}`} onClick={() => remove(b.id)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Compare documents: what's different in another document (or Word or Markdown file) from this one, or the other way round. */
function CompareDialog({ name, other, current, onClose }) {
  const [swapped, setSwapped] = useState(false);
  const box = useRef(null);
  const at = useRef(-1);
  const [from, to] = swapped ? [other.name, name] : [name, other.name];
  const next = (step) => {
    const all = [...(box.current?.querySelectorAll('.change-add, .change-del, .change-edit') || [])];
    if (!all.length) return;
    at.current = (at.current + step + all.length) % all.length;
    all.forEach((el, i) => el.classList.toggle('change-current', i === at.current));
    all[at.current].scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  return (
    <Modal wide title="Compare documents" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={() => next(-1)}>↑ Previous change</button>
      <button type="button" className="btn" onClick={() => next(1)}>↓ Next change</button>
      <button type="button" className="btn primary" onClick={onClose}>Done</button>
    </>}>
      <p className="row small" style={{ flexWrap: 'wrap' }}>
        <span>From <strong>{from}</strong> to <strong>{to}</strong>: <ins className="compare-key">added</ins> and <del className="compare-key">taken out</del>.</span>
        <button type="button" className="btn small" onClick={() => { setSwapped(!swapped); at.current = -1; }}>⇄ Swap</button>
      </p>
      <div ref={box} className="compare-body">
        <DocChanges key={String(swapped)} before={swapped ? other.content : current} after={swapped ? current : other.content}
          summary={(a, r) => (a || r ? `${to} has ${words(a)} that ${from} doesn't, and leaves out ${words(r)}.` : 'The text of the two is the same.')} />
      </div>
    </Modal>
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
export function DocPreview({ content, fileId, pictureBase = null }) {
  const editor = useEditor({
    editable: false,
    content,
    extensions: [
      StarterKit.configure({ link: { openOnClick: true }, document: false }), TabbedDocument, DocTab, TextAlign.configure({ types: ['heading', 'paragraph'] }),
      CommentMark, DocImage.configure({ docId: fileId, pictureBase }), Table, TableRow, TableHeader, TableCell, Superscript, Subscript, Indent,
      TextStyle, Color, BackgroundColor, FontFamily, FontSize, LineHeight, TableOfContents, SheetChart, PageBreak, Footnote, BookmarkNode, Mention, DropChip, DateChip, FileChip, EmailDraft, EventDraft, MathInline, Citation, References, TaskList, TaskItem.configure({ nested: true }),
    ],
  }, [content]);
  return <div className="paper preview-paper"><EditorContent editor={editor} /></div>;
}
