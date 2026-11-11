// Presentations: a slide list, a 16:9 canvas with text boxes, pictures and shapes you can move and
// resize, a full-screen presenter, and printing (Save as PDF). Edited together live, like Docs and Sheets.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SlideFind } from './SlideFind.jsx';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { CommentsPanel, useComments } from '../comments.jsx';
import { get, patch, post, uploadFile } from '../../api.js';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { jsonFromDeckDoc, applyDeckJson } from '../collabsync.js';
import { useAuth } from '../../App.jsx';
import { useToast, Menu, ConfirmModal, Avatar, Modal } from '../../components/ui.jsx';
import { QaPanel } from './SlideQa.jsx';
import DrivePicker from '../../components/DrivePicker.jsx';
import { chartChanged } from './linkedchart.js';
import { useChartNow, ChartPick, ChartBox } from '../ChartLink.jsx';
import Icon from '../../components/Icon.jsx';
import AltTextDialog from '../../components/AltTextDialog.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { VersionHistory } from '../VersionHistory.jsx';
import { EditorHeader } from '../editorCommon.jsx';
import { useUndo, undoKey } from '../useUndo.js';
import {
  THEMES, themeOf, masterOn, THEME_FONTS, CORNERS, cleanCustom, cleanMaster, LAYOUTS, numberShown, newId, moveBox, snapBox, angleTo, normAngle, alignItems, distributeItems, moveItems, pasteItems, resizeBox, addSlide, duplicateSlide, removeSlide, moveSlide, moveSlides, duplicateSlides, removeSlides,
  updateItem, addItem, removeItem, restack, pictureBox,
  TRANSITIONS, setSlide, stepSlide, firstShown, newTable, resizeTable, setCell,
  ANIMATIONS, builds, animChange, stepPresent, nextPresent, ADVANCES, advanceLabel, slideChanges, groupMembers, sharedGroup, groupItems, ungroupItems } from './slidemath.js';
import { cleanLink, linkTarget, linkLabel, slideTitle, dropLinksTo } from './slidelinks.js';
import { PRINT_LAYOUTS, printPages, isPortrait } from './printlayout.js';
import { slideFileName, zipStored } from './slideimages.js';

const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 54, 64, 72, 96];
const TEXT_COLORS = [['', 'Theme text'], ['accent', 'Theme accent'], ['#202124', 'Black'], ['#ffffff', 'White'], ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#1a73e8', 'Blue'], ['#8430ce', 'Purple']];
const FILLS = [['accent', 'Theme accent'], ['text', 'Theme text'], ['#e8f0fe', 'Light blue'], ['#e6f4ea', 'Light green'], ['#fef7e0', 'Light yellow'], ['#fce8e6', 'Light red'], ['#1a73e8', 'Blue'], ['#188038', 'Green'], ['#c5221f', 'Red'], ['#202124', 'Black'], ['#ffffff', 'White']];
import { GRAD_COLORS, GRAD_ANGLES, gradOf, gradValue, gradCss } from './slidegrad.js';
const BACKGROUNDS = [['', 'Theme background'], ['#ffffff', 'White'], ['#f1f3f4', 'Light grey'], ['#e8f0fe', 'Light blue'], ['#fef7e0', 'Light yellow'], ['#202124', 'Black'], ['#0b57d0', 'Blue']];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const PEOPLE_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#8430ce', '#00796b', '#c2185b', '#5f6368'];
const colorFor = (id) => PEOPLE_COLORS[[...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % PEOPLE_COLORS.length];
const PLACEHOLDER = { title: 'Click to add title', subtitle: 'Click to add subtitle', body: 'Click to add text' };

// Boxes copied with Ctrl+C (or cut with Ctrl+X), for pasting on any slide of this presentation or,
// apart from pictures and videos (kept with their own presentation), of another.
let boxClipboard = null; // { deckId, items }

export default function SlidesEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [file, setFile] = useState(null);
  const [deck, setDeck] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false); // phones: the tools fold away behind one button
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null); // item id
  const [also, setAlso] = useState([]); // more boxes chosen with Shift-click, moved and lined up together
  useEffect(() => { if (!selected) setAlso([]); }, [selected]);
  const [editing, setEditing] = useState(null);   // item id whose text is being typed
  const [presenting, setPresenting] = useState(null); // slide index, or null
  const [rehearsing, setRehearsing] = useState(false); // presenting to time each slide
  const [rehearsal, setRehearsal] = useState(null); // the times just taken: [{ i, ms }]
  const [dialog, setDialog] = useState(null);
  const [finding, setFinding] = useState(null); // the find bar: { replace, n }
  const [snapping, setSnapping] = useState(null); // slides being turned into pictures: { indexes, all }
  const [printing, setPrinting] = useState(null); // the print dialog (true), then what's printed: { layout, skipHidden }
  // Comments, each on a slide (by its id, so it follows the slide when slides move).
  const [params] = useSearchParams();
  const { threads } = useComments(file?.id);
  const [panel, setPanel] = useState(!!params.get('comment'));
  const [thread, setThread] = useState(params.get('comment'));
  const [pending, setPending] = useState(null);
  const deckRef = useRef(null);
  const pictureInput = useRef();
  const backgroundInput = useRef();
  const readOnly = (file?.role === 'viewer' || file?.role === 'commenter') || !!file?.locked_at;
  const canComment = !!file && file.role !== 'viewer'; // commenters too, and on locked files
  const [status, setStatus] = useState('connecting');
  const [others, setOthers] = useState([]);
  const [{ ydoc, provider }, setLink] = useState({});

  // The presentation is shared live (Yjs): slides and boxes merge one by one.
  useEffect(() => {
    let alive = true;
    get(`/files/${id}?open`).then((f) => {
      if (!alive) return;
      setFile(f);
      document.title = `${f.name} · Slides`;
      const ydoc = new Y.Doc();
      const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/collab`;
      const provider = new WebsocketProvider(url, f.id, ydoc, { maxBackoffTime: 5000 });
      provider.awareness.setLocalStateField('user', { id: user.id, name: user.name, color: colorFor(user.id) });
      const show = () => { const next = jsonFromDeckDoc(ydoc); deckRef.current = next; setDeck(next); };
      ydoc.on('update', show);
      provider.on('sync', (synced) => { if (synced) { show(); setStatus('saved'); } });
      provider.on('status', ({ status: st }) => setStatus(st === 'connected' ? (provider.synced ? 'saved' : 'connecting') : st === 'disconnected' ? 'offline' : 'connecting'));
      provider.on('connection-close', (e) => { if (e?.code === 4000) window.location.reload(); }); // a version was restored
      provider.awareness.on('change', () => setOthers([...provider.awareness.getStates().entries()]
        .filter(([cid, st]) => cid !== ydoc.clientID && st.user).map(([cid, st]) => ({ cid, ...st.user, sel: st.sel }))));
      setLink({ ydoc, provider });
    }).catch((e) => { if (e.status === 404) { navigate(`/access/${id}`, { replace: true }); return; } toast(e.message, 'error'); navigate('/drive'); });
    return () => { alive = false; document.title = 'Workspace'; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => () => { provider?.destroy(); ydoc?.destroy(); }, [provider, ydoc]);
  const history = useUndo(ydoc, (d) => [d.getMap('deck'), d.getArray('order'), d.getMap('slides')]);

  const commit = useCallback((next) => {
    if (readOnly || !ydoc) return;
    deckRef.current = next;
    setDeck(next);
    applyDeckJson(ydoc, next); // only the boxes and slides that changed go to the others
  }, [readOnly, ydoc]);
  const change = (fn) => commit(fn(deckRef.current));

  const slideIndex = deck ? Math.min(current, deck.slides.length - 1) : 0;
  const slide = deck?.slides[slideIndex];
  const group = selected ? [selected, ...also].filter((gid) => slide?.items.some((it) => it.id === gid)) : [];
  const multi = group.length > 1;
  const groupedAs = multi ? sharedGroup(slide, group) : null; // the chosen boxes are exactly one group
  const groupChosen = () => { if (group.length < 2) return; change((d) => groupItems(d, slideIndex, group)); toast(`Grouped ${group.length} boxes`); };
  const ungroupChosen = () => { change((d) => ungroupItems(d, slideIndex, group)); setAlso([]); toast('Ungrouped'); };
  const item = multi ? null : slide?.items.find((it) => it.id === selected) || null;
  const theme = themeOf(deck);
  // The latest deck (a slide may have just been added or removed in this same click).
  const slideNumberOf = (slideId) => (deck ? deck.slides.findIndex((x) => x.id === slideId) : -1);
  const slideLabel = (t) => { const n = slideNumberOf(t.anchor?.slide); return n < 0 ? 'A deleted slide' : `Slide ${n + 1}`; };
  const commentsOn = (slideId) => threads.filter((t) => !t.resolved && t.anchor?.slide === slideId).length;
  const openThreads = threads.filter((t) => !t.resolved).length;
  const showThread = (t) => { const n = slideNumberOf(t.anchor?.slide); if (n >= 0) goTo(n); };
  const commentOnSlide = () => {
    setPanel(true);
    setPending({ anchor: { slide: deck.slides[slideIndex].id }, label: `slide ${slideIndex + 1}`, onCreated: () => setPending(null), onCancel: () => setPending(null) });
  };
  const goTo = (i) => { setCurrent(Math.max(0, Math.min(deckRef.current.slides.length - 1, i))); setSelected(null); setEditing(null); };
  // Opened from a mention (?comment=…): go to that comment's slide once it's known.
  const jumped = useRef(false);
  useEffect(() => {
    const t = !jumped.current && thread && deck && threads.find((x) => x.id === thread);
    if (t) { jumped.current = true; showThread(t); }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard on the canvas: Delete removes, arrows nudge (Shift: further), Escape deselects.
  function onCanvasKey(e) {
    if (editing || readOnly) return;
    const u = undoKey(e);
    if (u) { e.preventDefault(); history[u](); return; }
    const mod = e.ctrlKey || e.metaKey;
    const chosen = multi ? group : item ? [item.id] : [];
    const key = e.key.toLowerCase();
    if (mod && (key === 'c' || key === 'x' || key === 'd') && chosen.length) {
      e.preventDefault();
      const items = slide.items.filter((it) => chosen.includes(it.id));
      if (key === 'd') { pasteBoxes(items); return; }
      boxClipboard = { deckId: id, items: JSON.parse(JSON.stringify(items)) };
      if (key === 'x') { change((d) => chosen.reduce((acc, gid) => removeItem(acc, slideIndex, gid), d)); setSelected(null); toast(chosen.length === 1 ? 'Cut 1 box' : `Cut ${chosen.length} boxes`); }
      else toast(chosen.length === 1 ? 'Copied 1 box' : `Copied ${chosen.length} boxes`);
      return;
    }
    if (mod && e.altKey && key === 'g') { e.preventDefault(); if (e.shiftKey) { if (groupedAs || item?.group) ungroupChosen(); } else if (multi) groupChosen(); return; }
    if (mod && key === 'v' && boxClipboard) { e.preventDefault(); pasteBoxes(boxClipboard.items, boxClipboard.deckId); return; }
    if (multi) {
      const step = e.shiftKey ? 5 : 1;
      const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (nudge) { e.preventDefault(); change((d) => moveItems(d, slideIndex, group, ...nudge)); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); change((d) => group.reduce((acc, gid) => removeItem(acc, slideIndex, gid), d)); setSelected(null); }
      else if (e.key === 'Escape') setSelected(null);
      return;
    }
    if (!item) {
      if (e.key === 'PageDown' || e.key === 'ArrowDown') { e.preventDefault(); goTo(slideIndex + 1); }
      if (e.key === 'PageUp' || e.key === 'ArrowUp') { e.preventDefault(); goTo(slideIndex - 1); }
      return;
    }
    const step = e.shiftKey ? 5 : 1;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (nudge) { e.preventDefault(); change((d) => updateItem(d, slideIndex, item.id, (it) => moveBox(it, ...nudge))); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); change((d) => removeItem(d, slideIndex, item.id)); setSelected(null); }
    else if (e.key === 'Escape') setSelected(null);
    else if (e.key === 'Enter' && (item.type === 'text' || boxShape(item))) { e.preventDefault(); setEditing(item.id); }
  }

  /** Put copies of boxes on this slide and choose them. */
  function pasteBoxes(items, fromDeck = id) {
    const usable = fromDeck === id ? items : items.filter((it) => it.type !== 'image' && it.type !== 'video' && it.type !== 'audio');
    if (usable.length < items.length) toast('Pictures, videos and sound stay with their own presentation: copy them from Drive instead', 'error');
    if (!usable.length) return;
    let ids = [];
    change((d) => { const r = pasteItems(d, slideIndex, usable); ids = r.ids; return r.deck; });
    setSelected(ids[0] || null); setAlso(ids.slice(1)); setEditing(null);
  }

  // Ctrl+F finds, Ctrl+H replaces: anywhere, even while typing in a box.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || presenting !== null || document.querySelector('.modal-backdrop')) return;
      const k = e.key.toLowerCase();
      if (k !== 'f' && k !== 'h') return;
      e.preventDefault();
      setFinding((f) => ({ replace: k === 'h', n: (f?.n || 0) + 1 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting]);

  // The keys work wherever focus is (after a toolbar button too), except while typing in a field.
  const keyRef = useRef(null);
  keyRef.current = onCanvasKey;
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (presenting !== null || document.querySelector('.modal-backdrop') || t.closest?.('input, textarea, select, [contenteditable="true"], [role="menu"]')) return;
      if ((e.key === 'Enter' || e.key === ' ') && t.closest?.('button, a')) return; // pressing a button
      keyRef.current?.(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting]);

  function insert(it) {
    const full = { id: newId(), ...it };
    change((d) => addItem(d, slideIndex, full));
    setSelected(full.id);
    if (full.type === 'text') setEditing(full.id);
  }

  // Videos: a Drive video (or one uploaded next to the presentation), 16:9, playing when presenting.
  const videoInput = useRef(null);
  const VIDEO_TYPES = /^video\/(mp4|webm|ogg|quicktime)$/;
  const putVideo = (v) => insert({ type: 'video', fileId: v.id, name: v.name, ...pictureBox(16, 9) });
  async function insertVideo(f) {
    if (!f) return;
    if (!VIDEO_TYPES.test(f.type)) return toast('Choose a video (MP4, WebM, Ogg or QuickTime)', 'error');
    try {
      let up;
      try { up = await uploadFile(f, file.parent_id || null); } catch { up = await uploadFile(f, null); }
      putVideo({ id: up.id, name: f.name });
    } catch (e) { toast(e.message, 'error'); }
  }
  // Sound: a Drive audio file (or one uploaded next to the presentation), a small box with 🔊; it plays with
  // its controls when presenting, or by itself as the slide shows when "Play by itself" is on.
  const audioInput = useRef(null);
  const AUDIO_TYPES = /^audio\/(mpeg|mp4|aac|x-m4a|wav|x-wav|wave|ogg|webm)$/;
  const putAudio = (a) => insert({ type: 'audio', fileId: a.id, name: a.name, x: 82, y: 80, w: 14, h: 12 });
  async function insertAudio(f) {
    if (!f) return;
    if (!AUDIO_TYPES.test(f.type)) return toast('Choose a sound file (MP3, M4A, WAV, Ogg or WebM)', 'error');
    try {
      let up;
      try { up = await uploadFile(f, file.parent_id || null); } catch { up = await uploadFile(f, null); }
      putAudio({ id: up.id, name: f.name });
    } catch (e) { toast(e.message, 'error'); }
  }
  // A picture behind everything on the slide, filling it (PNG, JPEG or GIF: what PowerPoint takes as a background too).
  const setBackground = (fileId) => change((d) => ({ ...d, slides: d.slides.map((s, i) => { if (i !== slideIndex) return s; const { bgImage, ...rest } = s; return fileId ? { ...rest, bgImage: fileId } : rest; }) }));
  async function setBackgroundPicture(f) {
    if (!f) return;
    if (!/^image\/(png|jpeg|gif)$/.test(f.type)) return toast('Choose a PNG, JPEG or GIF picture', 'error');
    try {
      let up;
      try { up = await uploadFile(f, file.parent_id || null); } catch { up = await uploadFile(f, null); }
      setBackground(up.id);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function insertPicture(f) {
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.type)) return toast('Choose a picture (PNG, JPEG, GIF or WebP)', 'error');
    try {
      // Next to the presentation when possible, so it's easy to find; otherwise in your Drive.
      let up;
      try { up = await uploadFile(f, file.parent_id || null); } catch { up = await uploadFile(f, null); }
      const size = await new Promise((ok) => { const img = new Image(); img.onload = () => ok([img.naturalWidth, img.naturalHeight]); img.onerror = () => ok([16, 9]); img.src = URL.createObjectURL(f); });
      insert({ type: 'image', fileId: up.id, name: f.name, ...pictureBox(...size) });
    } catch (e) { toast(e.message, 'error'); }
  }

  // Tell the others which slide and box are selected.
  useEffect(() => { provider?.awareness.setLocalStateField('sel', slide ? { slide: slide.id, item: selected } : null); }, [provider, slide?.id, selected]);

  // Grid view (all slides at once) and dragging slides into a new order.
  const [grid, setGrid] = useState(false);
  const [picked, setPicked] = useState(new Set()); // slides chosen in the grid (Ctrl/Shift-click)
  const [drag, setDrag] = useState(null); // { from: [indexes], at: drop position or null }
  const [altEdit, setAltEdit] = useState(null); // the picture whose alt text is being written
  if (!deck) return <div className="editor-page"><EditorHeader icon="slides" file={null} status="saved" /></div>;
  const people = [...new Map(others.map((p) => [p.id, p])).values()].filter((p) => p.id !== user.id);
  const peers = new Map(others.filter((p) => p.id !== user.id && p.sel?.slide === slide.id && p.sel.item).map((p) => [p.sel.item, p]));

  const setItem = (c) => item && change((d) => updateItem(d, slideIndex, item.id, c));
  const slideAction = (fn) => () => change(fn);
  // Grid view (all slides at once) and dragging slides into a new order, here and in the side list.
  const pickSlide = (i, e) => {
    if (e.shiftKey && picked.size) { const last = [...picked].pop(); const n = new Set(picked); for (let k = Math.min(last, i); k <= Math.max(last, i); k++) n.add(k); setPicked(n); return; }
    if (e.ctrlKey || e.metaKey) { const n = new Set(picked); if (n.has(i)) n.delete(i); else n.add(i); setPicked(n); return; }
    setPicked(new Set([i])); goTo(i);
  };
  const dragProps = (i, horizontal) => readOnly ? {} : {
    draggable: true,
    onDragStart: (e) => { const from = grid && picked.has(i) ? [...picked].sort((a, b) => a - b) : [i]; setDrag({ from, at: null }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'slides'); },
    onDragOver: (e) => {
      if (!drag) return;
      e.preventDefault();
      const b = e.currentTarget.getBoundingClientRect();
      const after = horizontal ? e.clientX > b.left + b.width / 2 : e.clientY > b.top + b.height / 2;
      const at = i + (after ? 1 : 0);
      if (drag.at !== at) setDrag({ ...drag, at });
    },
    onDrop: (e) => {
      e.preventDefault();
      if (!drag || drag.at === null) { setDrag(null); return; }
      const { deck: next, first } = moveSlides(deckRef.current, drag.from, drag.at);
      if (next !== deckRef.current) commit(next);
      setPicked(new Set(drag.from.map((_, k) => first + k)));
      goTo(first);
      setDrag(null);
    },
    onDragEnd: () => setDrag(null),
  };
  const dropClass = (i) => (drag && drag.at === i ? 'drop-before' : drag && drag.at === i + 1 && i === deck.slides.length - 1 ? 'drop-after' : '');
  const pickedList = () => [...picked].filter((i) => i < deck.slides.length).sort((a, b) => a - b);

  return (
    <div className="editor-page slides-page">
      <EditorHeader
        icon="slides" file={file} status={status}
        onRename={async (name) => setFile(await patch(`/files/${id}`, { name }))}
        onShare={() => setDialog('share')}
        extra={people.length > 0 && (
          <div className="coeditors" aria-label={`Also here: ${people.map((p) => p.name).join(', ')}`}>
            {people.slice(0, 4).map((p) => <span key={p.id} className="coeditor" style={{ '--c': p.color }} title={`${p.name} is here`}><Avatar name={p.name} size={28} userId={p.id} /></span>)}
            {people.length > 4 && <span className="muted small">+{people.length - 4}</span>}
          </div>
        )}
        menu={[
          { label: 'Present', icon: 'slides', onClick: () => setPresenting(slideIndex) },
          { label: 'Rehearse (time each slide)', icon: 'clock', onClick: () => { setRehearsing(true); setPresenting(firstShown(deck, 0)); } },
          { label: 'Find and replace', icon: 'search', onClick: () => setFinding((f) => ({ replace: !readOnly, n: (f?.n || 0) + 1 })) },
          { label: 'Version history', icon: 'clock', onClick: () => setDialog('history') },
          ...(!readOnly ? [{ label: 'Import slides…', icon: 'upload', onClick: () => setDialog({ type: 'import-file' }) }] : []),
          { label: 'Print or save as PDF…', icon: 'print', onClick: () => setPrinting(true) },
          { label: 'Download this slide as a picture (.png)', icon: 'image', onClick: () => setSnapping({ indexes: [slideIndex], all: false }) },
          { label: 'Download all slides as pictures (.zip)', icon: 'image', onClick: () => setSnapping({ indexes: deck.slides.map((_, i) => i), all: true }) },
          { label: 'Download as PowerPoint (.pptx)', icon: 'download', onClick: () => { window.location.href = `/api/files/${id}/export`; } },
          { label: 'Download as OpenDocument (.odp)', icon: 'download', onClick: () => { window.location.href = `/api/files/${id}/export?format=odp`; } },
          ...(!readOnly ? ['-', { label: `Loop: start again after the last slide${deck.loop ? ' ✓' : ''}`, onClick: () => change((d) => { const { loop, ...rest } = d; return loop ? rest : { ...rest, loop: true }; }) }, ...[[null, 'Slide numbers: off'], [true, 'Slide numbers: every slide'], ['skip-first', 'Slide numbers: all but the first']].map(([v, label]) => ({ label: `${label}${(deck.numbers || null) === v ? ' ✓' : ''}`, onClick: () => change((d) => { const { numbers, ...rest } = d; return v ? { ...rest, numbers: v } : rest; }) })),
            '-', ...Object.entries(THEMES).map(([k, t]) => ({ label: `Theme: ${t.name}${deck.theme === k ? ' ✓' : ''}`, onClick: () => change((d) => ({ ...d, theme: k })) })),
            { label: `Theme and logo…${deck.theme === 'custom' || deck.master ? ' ✓' : ''}`, icon: 'edit', onClick: () => setDialog({ type: 'theme' }) }] : []),
        ]}
      />
      {status === 'offline' && <div className="banner warn">You're offline. Keep editing: your changes are kept here and sync when the connection is back.</div>}
      {readOnly && <div className="banner">{file.locked_at ? 'Locked.' : file.role === 'commenter' ? 'You can comment, not edit.' : 'View only.'} {!file.locked_at && `Ask ${file.owner_name} for edit access.`}</div>}
      {!readOnly && (
        <div className={`slides-toolbar foldable ${toolsOpen ? 'open' : ''}`} role="toolbar" aria-label="Slide tools">
          <button type="button" className="tb tb-fold" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>{toolsOpen ? 'Hide tools ▴' : 'Tools ▾'}</button>
          <button type="button" className="tb" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>↶</button>
          <button type="button" className="tb" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!history.canRedo} onClick={history.redo}>↷</button>
          <span className="sep" />
          <Menu align="left" trigger={(p) => <button type="button" className="tb" {...p} aria-label="New slide" title="New slide"><Icon name="plus" size={18} /> Slide</button>}
            items={LAYOUTS.map(([k, label]) => ({ label, onClick: () => { change((d) => addSlide(d, slideIndex, k)); goTo(slideIndex + 1); } }))} />
          <span className="sep" />
          <button type="button" className="tb" onClick={() => insert({ type: 'text', role: 'body', x: 30, y: 40, w: 40, h: 14, text: '', size: 24 })}>Text box</button>
          <button type="button" className="tb" onClick={() => pictureInput.current.click()}>Picture</button>
          <Menu align="left" trigger={(p) => <button type="button" className="tb" {...p}>Video</button>} items={[
            { label: 'From Drive…', icon: 'folder', onClick: () => setDialog({ type: 'video-file' }) },
            { label: 'Upload a video…', icon: 'upload', onClick: () => videoInput.current.click() },
          ]} />
          <input ref={videoInput} type="file" accept="video/mp4,video/webm,video/ogg,video/quicktime" hidden aria-label="Video file" onChange={(e) => { insertVideo(e.target.files[0]); e.target.value = ''; }} />
          <Menu align="left" trigger={(p) => <button type="button" className="tb" {...p}>Audio</button>} items={[
            { label: 'From Drive…', icon: 'folder', onClick: () => setDialog({ type: 'audio-file' }) },
            { label: 'Upload a sound…', icon: 'upload', onClick: () => audioInput.current.click() },
          ]} />
          <input ref={audioInput} type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/x-m4a,audio/wav,audio/ogg,audio/webm,.mp3,.m4a,.wav,.ogg,.weba" hidden aria-label="Sound file" onChange={(e) => { insertAudio(e.target.files[0]); e.target.value = ''; }} />
          <button type="button" className="tb" onClick={() => insert({ type: 'table', x: 15, y: 25, w: 70, h: 40, size: 18, header: true, cells: newTable(3, 3) })}>Table</button>
          <button type="button" className="tb" onClick={() => setDialog({ type: 'chart-file' })}>Chart</button>
          <Menu align="left" trigger={(p) => <button type="button" className="tb" {...p}>Shape ▾</button>} items={[
            { label: 'Rectangle', onClick: () => insert({ type: 'shape', shape: 'rect', x: 35, y: 35, w: 30, h: 30, fill: 'accent' }) },
            { label: 'Rounded rectangle', onClick: () => insert({ type: 'shape', shape: 'round', x: 35, y: 35, w: 30, h: 30, fill: 'accent' }) },
            { label: 'Ellipse', onClick: () => insert({ type: 'shape', shape: 'ellipse', x: 40, y: 30, w: 20, h: 36, fill: 'accent' }) },
            { label: 'Triangle', onClick: () => insert({ type: 'shape', shape: 'triangle', x: 38, y: 30, w: 24, h: 36, fill: 'accent' }) },
            { label: 'Diamond', onClick: () => insert({ type: 'shape', shape: 'diamond', x: 38, y: 28, w: 24, h: 40, fill: 'accent' }) },
            { label: 'Block arrow', onClick: () => insert({ type: 'shape', shape: 'arrowblock', x: 33, y: 38, w: 34, h: 22, fill: 'accent' }) },
            { label: 'Chevron', onClick: () => insert({ type: 'shape', shape: 'chevron', x: 38, y: 36, w: 24, h: 26, fill: 'accent' }) },
            { label: 'Star', onClick: () => insert({ type: 'shape', shape: 'star', x: 38, y: 28, w: 24, h: 42, fill: 'accent' }) },
            { label: 'Speech bubble', onClick: () => insert({ type: 'shape', shape: 'callout', x: 33, y: 28, w: 34, h: 34, fill: 'accent' }) },
            { label: 'Line', onClick: () => insert({ type: 'shape', shape: 'line', dir: 'h', x: 30, y: 46, w: 40, h: 8, fill: 'text' }) },
            { label: 'Arrow', onClick: () => insert({ type: 'shape', shape: 'arrow', dir: 'h', x: 30, y: 46, w: 40, h: 8, fill: 'accent' }) },
          ]} />
          <input ref={pictureInput} type="file" accept="image/*" hidden onChange={(e) => { insertPicture(e.target.files[0]); e.target.value = ''; }} />
          <span className="sep" />
          {(item?.type === 'text' || boxShape(item)) && <>
            <select className="tb-select" aria-label="Text size" value={item.size || textSize(item)} onChange={(e) => setItem({ size: Number(e.target.value) })}>
              {[...new Set([...SIZES, item.size || textSize(item)])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" className={`tb ${item.bold ? 'on' : ''}`} aria-pressed={!!item.bold} aria-label="Bold" onClick={() => setItem({ bold: !item.bold })}><b>B</b></button>
            <button type="button" className={`tb ${item.italic ? 'on' : ''}`} aria-pressed={!!item.italic} aria-label="Italic" onClick={() => setItem({ italic: !item.italic })}><i>I</i></button>
            <select className="tb-select" aria-label="Text colour" value={item.color || ''} onChange={(e) => setItem({ color: e.target.value || undefined })}>
              {TEXT_COLORS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
            </select>
            {['left', 'center', 'right'].map((a) => (
              <button key={a} type="button" className={`tb ${(item.align || textAlignOf(item)) === a ? 'on' : ''}`} aria-pressed={(item.align || textAlignOf(item)) === a}
                aria-label={{ left: 'Align left', center: 'Centre', right: 'Align right' }[a]} onClick={() => setItem({ align: a })}>{{ left: '⯇', center: '≡', right: '⯈' }[a]}</button>
            ))}
          </>}
          {item?.type === 'table' && <>
            <select className="tb-select" aria-label="Text size" value={item.size || 18} onChange={(e) => setItem({ size: Number(e.target.value) })}>
              {[...new Set([...SIZES, item.size || 18])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" className="tb" aria-label="Add a row" title="Add a row at the bottom" disabled={item.cells.length >= 20} onClick={() => setItem({ cells: resizeTable(item.cells, item.cells.length + 1, item.cells[0].length) })}>+ Row</button>
            <button type="button" className="tb" aria-label="Remove the last row" title="Remove the last row" disabled={item.cells.length <= 1} onClick={() => setItem({ cells: resizeTable(item.cells, item.cells.length - 1, item.cells[0].length) })}>− Row</button>
            <button type="button" className="tb" aria-label="Add a column" title="Add a column at the right" disabled={item.cells[0].length >= 10} onClick={() => setItem({ cells: resizeTable(item.cells, item.cells.length, item.cells[0].length + 1) })}>+ Column</button>
            <button type="button" className="tb" aria-label="Remove the last column" title="Remove the last column" disabled={item.cells[0].length <= 1} onClick={() => setItem({ cells: resizeTable(item.cells, item.cells.length, item.cells[0].length - 1) })}>− Column</button>
            <button type="button" className={`tb ${item.header ? 'on' : ''}`} aria-pressed={!!item.header} aria-label="Heading row" title="First row as headings" onClick={() => setItem({ header: !item.header })}>Heading row</button>
          </>}
          {item?.type === 'shape' && (item.shape === 'line' || item.shape === 'arrow') && (
            <select className="tb-select" aria-label="Direction" value={item.dir || 'h'} onChange={(e) => setItem({ dir: e.target.value })}>
              {[['h', '→ Across'], ['v', '↓ Down'], ['d', '↘ Diagonal down'], ['u', '↗ Diagonal up'], ['hr', '← Across, backwards'], ['vr', '↑ Up']].map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
          )}
          {item?.type === 'shape' && (
            <select className="tb-select" aria-label="Shape colour" value={item.fill || 'accent'} onChange={(e) => setItem({ fill: e.target.value })}>
              {FILLS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
            </select>
          )}
          {item?.type === 'text' && (
            <select className="tb-select" aria-label="Box colour" value={item.fill || ''} onChange={(e) => setItem({ fill: e.target.value || undefined })}>
              <option value="">No box colour</option>
              {FILLS.map(([v, n]) => <option key={n} value={v}>{`Box: ${n}`}</option>)}
            </select>
          )}
          {outlineable(item) && <>
            <select className="tb-select" aria-label="Outline" value={item.outline || ''} onChange={(e) => setItem({ outline: e.target.value || undefined, ...(!e.target.value && { outlineW: undefined }) })}>
              <option value="">No outline</option>
              {FILLS.map(([v, n]) => <option key={n} value={v}>{`Outline: ${n}`}</option>)}
            </select>
            {item.outline && (
              <select className="tb-select" aria-label="Outline thickness" value={item.outlineW || 1} onChange={(e) => setItem({ outlineW: Number(e.target.value) })}>
                {OUTLINE_WIDTHS.map((w) => <option key={w} value={w}>{w} pt</option>)}
              </select>
            )}
          </>}
          {item?.type === 'chart' && (item.fileId ? <ChartUpdate item={item} onUpdate={(now) => setItem(now)} />
            : <span className="muted small" role="status" title="This chart came with a PowerPoint file: it keeps the figures it had there">Figures from PowerPoint</span>)}
          {item?.type === 'image' && (
            <button type="button" className={`tb labelled ${item.alt ? 'on' : ''}`} aria-label="Alt text" title={item.alt ? `Alt text: ${item.alt}` : 'Describe the picture for screen readers'} onClick={() => setAltEdit(item.id)}>Alt text{item.alt ? ' ✓' : ''}</button>
          )}
          {altEdit && item?.id === altEdit && (
            <AltTextDialog value={item.alt} onClose={() => setAltEdit(null)} onSave={(alt) => { setItem({ alt: alt || undefined }); setAltEdit(null); }} />
          )}
          {item && (
            <select className="tb-select" aria-label="Animation" title="How it comes in when presenting" value={item.anim || ''}
              onChange={(e) => setItem(animChange(deck.slides[slideIndex], item, e.target.value))}>
              {ANIMATIONS.map(([v, n]) => <option key={v} value={v}>{v ? `Animation: ${n}` : 'No animation'}</option>)}
            </select>
          )}
          {item?.type === 'audio' && (
            <label className="tb labelled" title="Start the sound by itself when this slide shows while presenting (it stops when the slide changes)">
              <input type="checkbox" checked={!!item.autoplay} onChange={(e) => setItem({ autoplay: e.target.checked || undefined })} /> Play by itself
            </label>
          )}
          {item && item.type !== 'video' && item.type !== 'audio' && (
            <button type="button" className={`tb labelled ${item.link ? 'on' : ''}`} aria-label="Link" title={item.link ? `Link: ${linkLabel(deck, item.link)}` : 'Link to a web page or another slide (followed when presenting)'}
              onClick={() => setDialog({ type: 'link', id: item.id })}>🔗 Link{item.link ? ' ✓' : ''}</button>
          )}
          {item && <>
            <label className="tb rot-field" title="Rotation in degrees">⟳<input type="number" aria-label="Rotation" min={-360} max={360} step={15} value={item.rot || 0}
              onChange={(e) => { const rot = normAngle(Number(e.target.value)); change((d) => updateItem(d, slideIndex, item.id, rot ? { rot } : { rot: undefined })); }} />°</label>
            <button type="button" className="tb" aria-label="Bring to front" title="Bring to front" onClick={() => change((d) => restack(d, slideIndex, item.id, 1))}>⤒</button>
            <button type="button" className="tb" aria-label="Send to back" title="Send to back" onClick={() => change((d) => restack(d, slideIndex, item.id, -1))}>⤓</button>
            <button type="button" className="tb" aria-label="Delete" title="Delete (Del)" onClick={() => { change((d) => removeItem(d, slideIndex, item.id)); setSelected(null); }}><Icon name="trash" size={18} /></button>
          </>}
          {multi && <>
            <span className="muted small">{groupedAs ? `Group of ${group.length}` : `${group.length} boxes`}</span>
            {groupedAs
              ? <button type="button" className="tb labelled" aria-label="Ungroup" title="Ungroup (Ctrl+Alt+Shift+G)" onClick={ungroupChosen}>⧉ Ungroup</button>
              : <button type="button" className="tb labelled" aria-label="Group" title="Group: move, copy and delete them as one (Ctrl+Alt+G)" onClick={groupChosen}>▣ Group</button>}
            {[['left', '⇤', 'Align left edges'], ['center', '⇹', 'Align centres (across)'], ['right', '⇥', 'Align right edges'], ['top', '⤒', 'Align top edges'], ['middle', '⇳', 'Align middles (down)'], ['bottom', '⤓', 'Align bottom edges']].map(([how, icon, label]) => (
              <button key={how} type="button" className="tb" aria-label={label} title={label} onClick={() => change((d) => alignItems(d, slideIndex, group, how))}>{icon}</button>
            ))}
            <button type="button" className="tb" aria-label="Distribute across" title="Space evenly across (three or more)" disabled={group.length < 3} onClick={() => change((d) => distributeItems(d, slideIndex, group, 'x'))}>↔ Space</button>
            <button type="button" className="tb" aria-label="Distribute down" title="Space evenly down (three or more)" disabled={group.length < 3} onClick={() => change((d) => distributeItems(d, slideIndex, group, 'y'))}>↕ Space</button>
            <button type="button" className="tb" aria-label="Delete" title="Delete them (Del)" onClick={() => { change((d) => group.reduce((acc, gid) => removeItem(acc, slideIndex, gid), d)); setSelected(null); }}><Icon name="trash" size={18} /></button>
          </>}
          {!item && !multi && (
            <select className="tb-select" aria-label="Slide background" value={slide.bg || ''} onChange={(e) => change((d) => ({ ...d, slides: d.slides.map((s, i) => (i === slideIndex ? { ...s, bg: e.target.value || undefined } : s)) }))}>
              {BACKGROUNDS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
            </select>
          )}
          {!item && !multi && (() => {
            // A gradient: from the background colour into another, in a direction.
            const g = gradOf(slide.bgGrad);
            const setGrad = (v) => change((d) => ({ ...d, slides: d.slides.map((s, i) => (i === slideIndex ? { ...s, bgGrad: v || undefined } : s)) }));
            return <>
              <select className="tb-select" aria-label="Background gradient" title="Fade the background into another colour" value={g?.to || ''} onChange={(e) => setGrad(e.target.value ? gradValue(e.target.value, g?.angle ?? 180) : null)}>
                <option value="">No gradient</option>
                {GRAD_COLORS.map(([v, n]) => <option key={v} value={v}>Gradient to {n.toLowerCase()}</option>)}
              </select>
              {g && <select className="tb-select" aria-label="Gradient direction" value={g.angle} onChange={(e) => setGrad(gradValue(g.to, Number(e.target.value)))}>
                {GRAD_ANGLES.map(([a, n]) => <option key={a} value={a}>{n}</option>)}
              </select>}
            </>;
          })()}
          {!item && !multi && (slide.bgImage
            ? <button type="button" className="tb" onClick={() => setBackground(null)}>Remove background picture</button>
            : <button type="button" className="tb" title="A picture behind everything on this slide, filling it" onClick={() => backgroundInput.current.click()}>Background picture</button>)}
          <input ref={backgroundInput} type="file" accept="image/png,image/jpeg,image/gif" hidden onChange={(e) => { setBackgroundPicture(e.target.files[0]); e.target.value = ''; }} />
          <div className="grow" />
          <button type="button" className={`btn small ${panel ? 'primary' : ''}`} aria-pressed={panel} title="Comments" onClick={() => { if (panel && pending) setPending(null); setPanel(!panel); }}>💬 Comments{openThreads ? ` (${openThreads})` : ''}</button>
          <button type="button" className="btn small" onClick={commentOnSlide}>Comment on this slide</button>
          <button type="button" className={`btn small ${grid ? 'primary' : ''}`} aria-pressed={grid} title="See all the slides at once, and drag them into order" onClick={() => { setGrid(!grid); setPicked(new Set([slideIndex])); }}>⊞ Grid view</button>
          <button type="button" className="btn small primary" onClick={() => setPresenting(slideIndex)}><Icon name="slides" size={16} /> Present</button>
          <button type="button" className="btn small" title="Present, with your notes, the next slide and a timer in a second window" onClick={() => { openPresenterView(id, slideIndex); setPresenting(slideIndex); }}>Presenter view</button>
        </div>
      )}
      {readOnly && <div className="slides-toolbar"><div className="grow" /><button type="button" className={`btn small ${panel ? 'primary' : ''}`} aria-pressed={panel} title="Comments" onClick={() => { if (panel && pending) setPending(null); setPanel(!panel); }}>💬 Comments{openThreads ? ` (${openThreads})` : ''}</button>
        {canComment && <button type="button" className="btn small" onClick={commentOnSlide}>Comment on this slide</button>}
          <button type="button" className={`btn small ${grid ? 'primary' : ''}`} aria-pressed={grid} title="See all the slides at once, and drag them into order" onClick={() => { setGrid(!grid); setPicked(new Set([slideIndex])); }}>⊞ Grid view</button>
          <button type="button" className="btn small primary" onClick={() => setPresenting(slideIndex)}><Icon name="slides" size={16} /> Present</button>
          <button type="button" className="btn small" title="Present, with your notes, the next slide and a timer in a second window" onClick={() => { openPresenterView(id, slideIndex); setPresenting(slideIndex); }}>Presenter view</button></div>}

      {grid && (
        <div className="slide-grid-wrap">
          {!readOnly && (
            <div className="row slide-grid-bar" role="toolbar" aria-label="Selected slides">
              <span className="muted small grow">{picked.size > 1 ? `${picked.size} slides selected` : 'Drag slides to put them in order. Ctrl or Shift-click to choose several.'}</span>
              <button type="button" className="btn small" disabled={!picked.size} onClick={() => { const list = pickedList(); change((d) => duplicateSlides(d, list)); const at = list[list.length - 1] + 1; setPicked(new Set(list.map((_, k) => at + k))); }}>Duplicate</button>
              <button type="button" className="btn small" disabled={!picked.size} onClick={() => { const list = pickedList(); const skip = !list.every((i) => deck.slides[i].skip); change((d) => ({ ...d, slides: d.slides.map((x, i) => (list.includes(i) ? { ...x, skip: skip || undefined } : x)) })); }}>Skip / show</button>
              <button type="button" className="btn small danger" disabled={!picked.size} onClick={() => setDialog({ type: 'delete-slides', list: pickedList() })}>Delete</button>
            </div>
          )}
          <ol className="slide-grid" aria-label="All slides">
            {deck.slides.map((s, i) => (
              <li key={s.id} className={`${picked.has(i) ? 'picked' : ''} ${s.skip ? 'skipped' : ''} ${dropClass(i)}`} {...dragProps(i, true)}>
                <button type="button" className="thumb" aria-label={`Slide ${i + 1}`} aria-pressed={picked.has(i)} onClick={(e) => pickSlide(i, e)} onDoubleClick={() => { goTo(i); setGrid(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goTo(i); setGrid(false); } }}>
                  <SlideView slide={s} theme={theme} deckId={id} number={numberShown(deck, i) ? i + 1 : null} />
                </button>
                <span className="muted small">{i + 1}{s.skip ? ' · skipped' : ''}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {finding && !grid && <SlideFind key={finding.n} deck={deck} replacing={finding.replace} canEdit={!readOnly}
        onGo={(m) => {
          setCurrent(m.slide); setEditing(null); setSelected(m.notes ? null : m.item);
          if (m.notes) requestAnimationFrame(() => document.querySelector('.slide-notes')?.scrollIntoView({ block: 'nearest' }));
        }}
        onReplace={(next, count) => { commit(next); toast(count === 1 ? 'Replaced 1' : `Replaced ${count}`); }}
        onClose={() => setFinding(null)} />}
      <div className="slides-body" style={grid ? { display: 'none' } : undefined}>
        <ol className="slide-list" aria-label="Slides">
          {deck.slides.map((s, i) => (
            <li key={s.id} className={`${i === slideIndex ? 'on' : ''} ${s.skip ? 'skipped' : ''} ${dropClass(i)}`} {...dragProps(i, false)}>
              <span className="num" aria-hidden="true">{i + 1}{commentsOn(s.id) > 0 && <span className="thumb-mark" title={`${commentsOn(s.id)} open comment${commentsOn(s.id) === 1 ? '' : 's'}`}>💬</span>}{s.transition && <span className="thumb-mark" title={`Transition: ${s.transition}`}>✦</span>}{s.skip && <span className="thumb-mark" title="Skipped when presenting">⊘</span>}{s.advance > 0 && <span className="thumb-mark" title={`Moves on by itself after ${s.advance} s`}>⏱</span>}</span>
              <button type="button" className="thumb" aria-label={`Slide ${i + 1}`} aria-current={i === slideIndex ? 'true' : undefined} onClick={() => goTo(i)}>
                <SlideView slide={s} theme={theme} deckId={id} number={numberShown(deck, i) ? i + 1 : null} />
              </button>
              {!readOnly && (
                <Menu trigger={(p) => <button type="button" className="icon-btn thumb-menu" aria-label={`Options for slide ${i + 1}`} {...p}><Icon name="more" size={16} /></button>} items={[
                  { label: 'Duplicate', onClick: slideAction((d) => duplicateSlide(d, i)) },
                  i > 0 && { label: 'Move up', onClick: () => { change((d) => moveSlide(d, i, i - 1)); goTo(i - 1); } },
                  i < deck.slides.length - 1 && { label: 'Move down', onClick: () => { change((d) => moveSlide(d, i, i + 1)); goTo(i + 1); } },
                  '-',
                  { label: s.skip ? 'Show when presenting' : 'Skip when presenting', onClick: slideAction((d) => setSlide(d, i, { skip: !s.skip })) },
                  ...TRANSITIONS.map(([v, name]) => ({ label: `${(s.transition || '') === v ? '✓ ' : ''}Transition: ${name}`, onClick: slideAction((d) => setSlide(d, i, { transition: v })) })),
                  '-',
                  ...ADVANCES.map((v) => ({ label: `${(s.advance || 0) === v ? '✓ ' : ''}Move on by itself: ${advanceLabel(v).toLowerCase()}`, onClick: slideAction((d) => setSlide(d, i, { advance: v || null })) })),
                  '-',
                  { label: 'Delete slide', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete-slide', index: i }) },
                ]} />
              )}
            </li>
          ))}
        </ol>
        <div className="slide-stage" tabIndex={-1} onPointerDown={(e) => { if (e.target === e.currentTarget) { setSelected(null); setEditing(null); } }}>
          <SlideView slide={slide} theme={theme} deckId={id} number={numberShown(deck, slideIndex) ? slideIndex + 1 : null} editable={!readOnly} selected={selected} group={group} editing={editing} peers={peers}
            onSelect={(itemId, shift) => {
              if (shift && selected && itemId !== selected) { setAlso((a) => (a.includes(itemId) ? a.filter((x) => x !== itemId) : [...a, itemId])); setEditing(null); return; }
              // A box in a group chooses the whole group (double-click one to type in it on its own).
              setSelected(itemId); setAlso(groupMembers(slide, itemId).filter((x) => x !== itemId)); if (itemId !== editing) setEditing(null);
            }}
            onMoveMany={(ids, dx, dy) => change((d) => moveItems(d, slideIndex, ids, dx, dy))}
            onEdit={(itemId) => { if (itemId) { setSelected(itemId); setAlso([]); } setEditing(itemId); }}
            onChange={(itemId, c) => change((d) => updateItem(d, slideIndex, itemId, c))} />
          <p className="muted small slide-count">Slide {slideIndex + 1} of {deck.slides.length}</p>
          {readOnly ? (slide.notes && <div className="slide-notes read"><span className="muted small">Speaker notes</span><p>{slide.notes}</p></div>) : (
            <label className="slide-notes"><span className="muted small">Speaker notes</span>
              <textarea rows={3} value={slide.notes || ''} placeholder="Notes for this slide: only you see them while presenting" maxLength={20000}
                onChange={(e) => { const notes = e.target.value; change((d) => ({ ...d, slides: d.slides.map((x, i) => (i === slideIndex ? { ...x, notes: notes || undefined } : x)) })); }} />
            </label>
          )}
        </div>
        {panel && <CommentsPanel fileId={file.id} threads={threads} canEdit={canComment} active={thread} setActive={setThread} pending={pending}
          onShow={showThread} labelOf={slideLabel} onClose={() => { setPending(null); setPanel(false); }} />}
      </div>

      {snapping && <SlideSnaps deck={deck} theme={theme} deckId={id} title={file.name} job={snapping} onDone={(err) => { setSnapping(null); if (err) toast(err, 'error'); }} />}
      <PrintDeck deck={deck} theme={theme} deckId={id} title={file.name} how={printing && printing !== true ? printing : { layout: 'slides', skipHidden: true }} />
      {printing === true && <PrintDialog deck={deck} onClose={() => setPrinting(null)} onPrint={(how) => {
        setPrinting(how);
        document.body.classList.add('printing-deck'); // the print styles show just the slides
        // The paper's way round, for this print only (a named @page doesn't reach the absolutely placed pages).
        const size = document.createElement('style');
        size.textContent = isPortrait(how.layout) ? '@page { size: A4 portrait; margin: 13mm; }' : '@page { size: landscape; margin: 0; }';
        document.head.appendChild(size);
        const done = () => { document.body.classList.remove('printing-deck'); size.remove(); window.removeEventListener('afterprint', done); setPrinting(null); };
        window.addEventListener('afterprint', done);
        setTimeout(() => { window.print(); setTimeout(done, 1000); }, 60); // once the pages are laid out
      }} />}
      {presenting !== null && <Presenter deck={deck} theme={theme} deckId={id} start={presenting} rehearse={rehearsing} onClose={(i, timed) => { setPresenting(null); setRehearsing(false); goTo(i); if (timed) setRehearsal(timed); }} />}
      {rehearsal && <RehearsalSummary deck={deck} deckId={id} timed={rehearsal} onClose={() => setRehearsal(null)} />}
      {dialog === 'share' && <ShareDialog file={file} onClose={() => setDialog(null)} />}
      {dialog?.type === 'theme' && <ThemeDialog deck={deck} deckId={id} slide={slide} parentId={file.parent_id || null}
        onSave={({ custom, master }) => { change((d) => { const { master: _, ...rest } = d; return { ...rest, ...(custom && { theme: 'custom', custom }), ...(master && { master }) }; }); setDialog(null); }}
        onClose={() => setDialog(null)} />}
      {dialog === 'history' && <VersionHistory file={file} canEdit={!readOnly} onClose={() => setDialog(null)} renderPreview={(content) => (
        <div className="deck-preview">{(content?.slides || []).map((sl, n) => <div key={sl.id || n} className="deck-preview-slide"><span className="muted small">{n + 1}</span><SlideView slide={sl} theme={themeOf(content)} deckId={file.id} /></div>)}</div>
      )} renderChanges={(content) => <SlideChanges before={content} after={deckRef.current} theme={theme} deckId={file.id} />} />}
      {dialog?.type === 'import-file' && <DrivePicker title="Import slides from a presentation" accept={(x) => x.kind === 'slides' && x.id !== id} empty="No other presentations found."
        onClose={() => setDialog(null)} onPick={(x) => setDialog({ type: 'import-pick', file: x })} />}
      {dialog?.type === 'import-pick' && <ImportSlides from={dialog.file} onClose={() => setDialog(null)} onImport={async (ids) => {
        try {
          const r = await post(`/files/${id}/import-slides`, { from: dialog.file.id, slides: ids });
          const at = slideIndex + 1;
          change((d) => ({ ...d, slides: [...d.slides.slice(0, at), ...r.slides, ...d.slides.slice(at)] }));
          setDialog(null);
          goTo(at);
          toast(`${r.slides.length === 1 ? '1 slide' : `${r.slides.length} slides`} imported from “${dialog.file.name}”`);
        } catch (e) { toast(e.message, 'error'); }
      }} />}
      {dialog?.type === 'audio-file' && <DrivePicker title="Sound from Drive" accept={(x) => x.kind === 'file' && AUDIO_TYPES.test(x.mime || '')} empty="No sound files found in your Drive."
        onClose={() => setDialog(null)} onPick={(f) => { setDialog(null); putAudio(f); }} />}
      {dialog?.type === 'video-file' && <DrivePicker title="Video from Drive" accept={(x) => x.kind === 'file' && VIDEO_TYPES.test(x.mime || '')} empty="No videos found in your Drive."
        onClose={() => setDialog(null)} onPick={(f) => { setDialog(null); putVideo(f); }} />}
      {dialog?.type === 'chart-file' && <DrivePicker title="Chart from a spreadsheet" accept={(x) => x.kind === 'sheet'} empty="No spreadsheets found."
        onClose={() => setDialog(null)} onPick={(x) => setDialog({ type: 'chart-pick', file: x })} />}
      {dialog?.type === 'chart-pick' && <ChartPick file={dialog.file} onClose={() => setDialog(null)}
        onPick={(c) => { setDialog(null); insert({ type: 'chart', fileId: dialog.file.id, chartId: c.id, ...c.now, x: 15, y: 18, w: 70, h: 66 }); }} />}
      {dialog?.type === 'link' && item?.id === dialog.id && (
        <LinkDialog deck={deck} here={slideIndex} link={item.link} onClose={() => setDialog(null)}
          onSave={(link) => { setItem({ link: cleanLink(link, deck.slides.map((x) => x.id)) || undefined }); setDialog(null); }} />
      )}
      {dialog?.type === 'delete-slide' && (
        <ConfirmModal title={`Delete slide ${dialog.index + 1}?`} confirm="Delete" message="The slide and everything on it is removed. Version history can bring it back."
          onClose={() => setDialog(null)} onConfirm={() => { change((d) => dropLinksTo(removeSlide(d, dialog.index), d.slides[dialog.index].id)); goTo(Math.min(dialog.index, deck.slides.length - 2)); setDialog(null); }} />
      )}
      {dialog?.type === 'delete-slides' && (
        <ConfirmModal title={`Delete ${dialog.list.length} slide${dialog.list.length === 1 ? '' : 's'}?`} message="They can be brought back from Version history." confirm="Delete"
          onClose={() => setDialog(null)} onConfirm={() => { change((d) => removeSlides(d, dialog.list)); setPicked(new Set()); goTo(Math.min(dialog.list[0], deck.slides.length - dialog.list.length - 1)); setDialog(null); }} />
      )}
    </div>
  );
}

const colorOf = (v, theme, fallback) => (v === 'accent' ? theme.accent : v === 'text' ? theme.text : v || fallback);

/**
 * One slide. Sizes are in percent of the slide, text in 1/1000 of its width, so the same slide
 * draws the same in a thumbnail, the editor, full screen and on paper.
 */
/** Pick slides from another presentation to bring into this one (after the current slide). */
function ImportSlides({ from, onClose, onImport }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { get(`/files/${from.id}/content`).then((r) => setSrc(r.content)).catch((e) => setError(e.message)); }, [from.id]);
  const slides = src?.slides || [];
  const toggle = (sid) => setChosen((c) => { const n = new Set(c); if (n.has(sid)) n.delete(sid); else n.add(sid); return n; });
  return (
    <Modal title={`Import slides from “${from.name}”`} wide onClose={onClose}
      footer={<>
        <button type="button" className="link-btn small" disabled={!slides.length} onClick={() => setChosen(chosen.size === slides.length ? new Set() : new Set(slides.map((sl) => sl.id)))}>{chosen.size === slides.length && slides.length ? 'Select none' : 'Select all'}</button>
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!chosen.size || busy} onClick={async () => { setBusy(true); await onImport(slides.filter((sl) => chosen.has(sl.id)).map((sl) => sl.id)); setBusy(false); }}>
          {chosen.size ? `Import ${chosen.size === 1 ? '1 slide' : `${chosen.size} slides`}` : 'Import'}</button>
      </>}>
      {error ? <p className="error">{error}</p> : !src ? <p className="muted">Loading…</p> : (
        <div className="deck-preview import-slides" role="group" aria-label="Slides to import">
          {slides.map((sl, n) => (
            <label key={sl.id} className={`deck-preview-slide import-slide ${chosen.has(sl.id) ? 'on' : ''}`}>
              <span className="row small"><input type="checkbox" checked={chosen.has(sl.id)} onChange={() => toggle(sl.id)} aria-label={`Slide ${n + 1}`} /> {n + 1}</span>
              <SlideView slide={sl} theme={themeOf(src)} deckId={from.id} />
            </label>
          ))}
        </div>
      )}
      <p className="muted small">They go after the current slide, in this presentation's theme. Pictures are copied for you.</p>
    </Modal>
  );
}

/** A rectangle, rounded rectangle or ellipse: shapes that can hold text (not lines or arrows). */
const boxShape = (it) => it?.type === 'shape' && it.shape !== 'line' && it.shape !== 'arrow';
const textSize = (it) => (it?.type === 'shape' ? 20 : 24);
const textAlignOf = (it) => (it?.type === 'shape' ? 'center' : 'left');
/** Shapes and text boxes that can have an outline (the cut-out shapes can't show one along their edge). */
const outlineable = (it) => it?.type === 'text' || (it?.type === 'shape' && ['rect', 'round', 'ellipse'].includes(it.shape));
const OUTLINE_WIDTHS = [1, 2, 4, 6]; // points, as PowerPoint
/** The outline as CSS: a point is 1/960 of the slide's width (a 13.33-inch slide). */
const outlineCss = (it, theme) => (it.outline ? { border: `calc(${OUTLINE_WIDTHS.includes(it.outlineW) ? it.outlineW : 1} * 100cqw / 960) solid ${colorOf(it.outline, theme, theme.text)}`, boxSizing: 'border-box' } : {});

/** Slides as pictures: drawn off-screen at 1600 × 900, then saved as a .png (one) or a .zip of them (all). */
function SlideSnaps({ deck, theme, deckId, title, job, onDone }) {
  const box = useRef();
  const toast = useToast();
  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        if (job.all) toast(`Making pictures of ${job.indexes.length} slides…`, 'info');
        const { toBlob } = await import('html-to-image');
        await document.fonts?.ready;
        const files = [];
        for (const i of job.indexes) {
          const el = box.current?.querySelector(`[data-snap="${i}"] .slide`);
          if (!el || gone) return;
          const blob = await toBlob(el, { width: 1600, height: 900, pixelRatio: 1, cacheBust: false });
          files.push({ name: slideFileName(title, i + 1, deck.slides.length), bytes: new Uint8Array(await blob.arrayBuffer()) });
        }
        if (gone) return;
        const save = (data, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); };
        if (job.all) save(zipStored(files), `${slideFileName(title, 0, 1).replace(/ - 0\.png$/, '')} slides.zip`, 'application/zip');
        else save(files[0].bytes, files[0].name, 'image/png');
        onDone();
      } catch (e) { if (!gone) onDone(`Couldn't make the picture: ${e.message || e}`); }
    })();
    return () => { gone = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={box} className="slide-snaps" aria-hidden="true">
      {job.indexes.map((i) => <div key={deck.slides[i].id} data-snap={i} style={{ width: 1600 }}><SlideView slide={deck.slides[i]} theme={theme} deckId={deckId} number={numberShown(deck, i) ? i + 1 : null} /></div>)}
    </div>
  );
}

/** Printing: what to print (one slide per page, with notes, or handouts) and whether skipped slides go too. */
function PrintDialog({ deck, onClose, onPrint }) {
  const [layout, setLayout] = useState('slides');
  const [skipHidden, setSkipHidden] = useState(true);
  const skipped = deck.slides.filter((s) => s.skip).length;
  const pages = printPages(deck.slides, { layout, skipHidden }).length;
  return (
    <Modal title="Print or save as PDF" onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={!pages} onClick={() => onPrint({ layout, skipHidden })}>Print…</button></>}>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="muted small">Print</legend>
        {PRINT_LAYOUTS.map(([v, label]) => <label key={v} className="check"><input type="radio" name="print-layout" checked={layout === v} onChange={() => setLayout(v)} /> {label}</label>)}
      </fieldset>
      {skipped > 0 && <label className="check"><input type="checkbox" checked={!skipHidden} onChange={(e) => setSkipHidden(!e.target.checked)} /> Include skipped slides ({skipped})</label>}
      <p className="muted small" role="status">{pages} page{pages === 1 ? '' : 's'}, {isPortrait(layout) ? 'portrait' : 'landscape'}. Choose “Save as PDF” in the print dialog for a PDF.</p>
    </Modal>
  );
}

/** The pages printed (hidden on screen): slides, slides with their notes, or handouts with the title and page numbers. */
function PrintDeck({ deck, theme, deckId, title, how }) {
  const pages = printPages(deck.slides, how);
  const slideOf = (x) => <SlideView slide={x.slide} theme={theme} deckId={deckId} number={numberShown(deck, x.number - 1) ? x.number : null} />;
  if (how.layout === 'slides') return <div className="print-deck" aria-hidden="true">{pages.map(([x]) => <div key={x.slide.id} className="print-slide">{slideOf(x)}</div>)}</div>;
  return (
    <div className={`print-deck portrait layout-${how.layout}`} aria-hidden="true">
      {pages.map((page, p) => (
        <div key={p} className="print-page">
          <div className="print-page-head"><span>{title}</span><span>{p + 1} / {pages.length}</span></div>
          {how.layout === 'notes' ? (
            <>{slideOf(page[0])}<div className="print-notes"><strong>Slide {page[0].number}</strong>{page[0].slide.notes ? <p>{page[0].slide.notes}</p> : <p className="muted">No speaker notes</p>}</div></>
          ) : (
            <div className="print-handout">
              {page.map((x) => (
                <div key={x.slide.id} className="print-handout-item">
                  <div className="print-handout-slide">{slideOf(x)}<span className="print-handout-no">{x.number}</span></div>
                  {how.layout === 'h3' && <div className="print-lines" aria-hidden="true">{Array.from({ length: 7 }, (_, k) => <i key={k} />)}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SlideView({ slide, theme, deckId, editable, selected, group = [], editing, onSelect, onEdit, onChange, onMoveMany, peers, built, number, pictureBase = null, playing = false }) {
  // Animated boxes: where each comes in (1, 2…). Presenting (built set), the later ones aren't in yet.
  const buildAt = new Map(builds(slide).map((it, k) => [it.id, k + 1]));
  const ref = useRef();
  const [live, setLive] = useState(null); // { id, box } while dragging

  function startDrag(e, it, handle = null) {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    if (!handle && e.shiftKey) { onSelect(it.id, true); return; } // Shift-click adds (or takes away) a box
    if (!handle && group.length > 1 && group.includes(it.id)) { // dragging one of several moves them all
      const rect = ref.current.getBoundingClientRect();
      const mine = slide.items.filter((o) => group.includes(o.id));
      const left = Math.min(...mine.map((b) => b.x)), right = Math.max(...mine.map((b) => b.x + b.w));
      const top = Math.min(...mine.map((b) => b.y)), bottom = Math.max(...mine.map((b) => b.y + b.h));
      const x0 = e.clientX, y0 = e.clientY;
      let dx = 0, dy = 0;
      const move = (m) => {
        dx = Math.min(Math.max(((m.clientX - x0) / rect.width) * 100, -left), 100 - right);
        dy = Math.min(Math.max(((m.clientY - y0) / rect.height) * 100, -top), 100 - bottom);
        setLive({ group, dx, dy });
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        setLive(null);
        if (dx || dy) onMoveMany(group, dx, dy);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    onSelect(it.id);
    if (editing === it.id && !handle) return; // typing: let the cursor move in the text
    const rect = ref.current.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    if (handle === 'rot') { // turning it round its centre (in 15° steps; Shift for any angle)
      const cx = rect.left + ((it.x + it.w / 2) / 100) * rect.width, cy = rect.top + ((it.y + it.h / 2) / 100) * rect.height;
      let rot = it.rot || 0;
      const turn = (m) => { rot = angleTo(cx, cy, m.clientX, m.clientY, !m.shiftKey); setLive({ id: it.id, box: { ...it, rot } }); };
      const done = () => {
        window.removeEventListener('pointermove', turn); window.removeEventListener('pointerup', done);
        setLive(null);
        if (rot !== (it.rot || 0)) onChange(it.id, { rot });
      };
      window.addEventListener('pointermove', turn); window.addEventListener('pointerup', done);
      return;
    }
    const ratio = it.type === 'image' ? it.w / it.h : null;
    let box = null, moved = false;
    const move = (m) => {
      const dx = ((m.clientX - x0) / rect.width) * 100, dy = ((m.clientY - y0) / rect.height) * 100;
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 3) return;
      moved = true;
      box = handle ? resizeBox(it, handle, dx, dy, m.shiftKey ? null : ratio) : moveBox(it, dx, dy);
      // Moving: line up with the slide and the other boxes (Alt held: no snapping).
      let guides = [];
      if (!handle && !m.altKey) ({ box, guides } = snapBox(box, slide.items.filter((o) => o.id !== it.id)));
      setLive({ id: it.id, box, guides });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      if (moved && box) onChange(it.id, { x: box.x, y: box.y, w: box.w, h: box.h });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  return (
    <div ref={ref} className={`slide ${editable ? 'editable' : ''} ${slide.bgImage ? 'has-bg-picture' : ''}`} style={{ background: slide.bgImage ? `url("${pictureBase || `/api/files/${deckId}`}/pictures/${slide.bgImage}") center / cover no-repeat, ${gradCss(slide.bg || theme.bg, slide.bgGrad)}` : gradCss(slide.bg || theme.bg, slide.bgGrad), color: theme.text, ...(theme.font && { fontFamily: `"${theme.font}", sans-serif` }) }} role={editable ? 'group' : undefined} aria-label={editable ? 'Slide' : undefined}>
      {slide.items.map((it) => {
        const box = live?.id === it.id ? live.box : live?.group?.includes(it.id) ? { ...it, x: it.x + live.dx, y: it.y + live.dy } : it;
        const pos = { left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%`, ...(box.rot ? { transform: `rotate(${box.rot}deg)` } : {}) };
        const inGroup = editable && group.length > 1 && group.includes(it.id);
        const isSel = editable && selected === it.id && !inGroup;
        let inner = null;
        if (it.type === 'text') {
          const style = { fontSize: `calc(${it.size || 24} * 0.1cqw)`, fontWeight: it.bold ? 700 : 400, fontStyle: it.italic ? 'italic' : 'normal', textAlign: it.align || 'left', color: colorOf(it.color, theme, theme.text),
            ...(it.fill && { background: colorOf(it.fill, theme, theme.accent), padding: '0.6cqw 0.8cqw', boxSizing: 'border-box' }), ...outlineCss(it, theme) };
          inner = editable && editing === it.id
            ? <textarea autoFocus className="slide-text editing" style={style} defaultValue={it.text} aria-label="Text"
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); } }}
                onChange={(e) => onChange(it.id, { text: e.target.value })} /* saved as you type */
                onBlur={() => onEdit(null)} />
            : <div className={`slide-text ${!it.text ? 'slide-placeholder' : ''}`} style={style}>{it.text || (editable ? PLACEHOLDER[it.role] || 'Click to add text' : '')}</div>;
        } else if (it.type === 'image') {
          // Through the deck (works for everyone who can open it, once saved); just after inserting,
          // before the save, the person who added it opens the picture file directly.
          inner = <img src={`${pictureBase || `/api/files/${deckId}`}/pictures/${it.fileId}`} alt={it.alt || it.name || ''} draggable={false}
            onError={(e) => { const direct = `/api/files/${it.fileId}/raw`; if (!e.currentTarget.src.endsWith(direct)) e.currentTarget.src = direct; }} />;
        } else if (it.type === 'video') {
          // Editing: its first frame with ▶ (so the box can be moved); presenting or viewing: plays with its controls.
          const src = `${pictureBase || `/api/files/${deckId}`}/pictures/${it.fileId}`;
          inner = editable
            ? <div className="slide-video editing"><video src={src} preload="metadata" muted aria-hidden="true" /><span className="slide-video-play" aria-hidden="true">▶</span></div>
            : <video className="slide-video" src={src} controls preload="metadata" aria-label={`Video: ${it.name || ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} />;
        } else if (it.type === 'audio') {
          // Editing: 🔊 and its name (a box to move); presenting or viewing: the player (by itself when presenting, if asked).
          const src = `${pictureBase || `/api/files/${deckId}`}/pictures/${it.fileId}`;
          inner = editable
            ? <div className="slide-audio editing"><span aria-hidden="true">🔊</span><span className="slide-audio-name">{it.name || 'Sound'}{it.autoplay ? ' · plays by itself' : ''}</span></div>
            : <div className="slide-audio"><audio src={src} controls preload="metadata" autoPlay={playing && !!it.autoplay} aria-label={`Sound: ${it.name || ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} /></div>;
        } else if (it.type === 'table') {
          const typing = editable && editing === it.id;
          inner = (
            <table className={`slide-table ${it.header ? 'with-header' : ''}`} style={{ fontSize: `calc(${it.size || 18} * 0.1cqw)`, '--line': theme.text, '--head': theme.accent, '--head-text': theme.bg, '--cell': slide.bg || theme.bg }}>
              <tbody>
                {(it.cells || []).map((row, r) => (
                  <tr key={r}>{row.map((text, c) => {
                    const Cell = it.header && r === 0 ? 'th' : 'td';
                    return <Cell key={c}>{typing
                      ? <input className="slide-cell" defaultValue={text} aria-label={`Row ${r + 1}, column ${c + 1}`} autoFocus={r === 0 && c === 0}
                          onPointerDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEdit(null); } }}
                          onChange={(e) => onChange(it.id, { cells: setCell(it.cells, r, c, e.target.value) })} />
                      : text}</Cell>;
                  })}</tr>
                ))}
              </tbody>
            </table>
          );
        } else if (it.type === 'chart') {
          inner = <ChartBox item={it} />; // from the copy kept on the slide
        } else if (it.type === 'shape') {
          inner = it.shape === 'line' || it.shape === 'arrow'
            ? <LineShape arrow={it.shape === 'arrow'} dir={it.dir || 'h'} color={colorOf(it.fill, theme, theme.accent)} />
            : (() => {
              // Text in a box shape: centred, in the slide's background colour unless chosen (it sits on the shape's colour).
              const style = { fontSize: `calc(${it.size || textSize(it)} * 0.1cqw)`, fontWeight: it.bold ? 700 : 400, fontStyle: it.italic ? 'italic' : 'normal', textAlign: it.align || 'center', color: colorOf(it.color, theme, theme.bg) };
              return (
                <div className={`slide-shape ${it.shape}`} style={{ background: colorOf(it.fill, theme, theme.accent), ...outlineCss(it, theme) }}>
                  {editable && editing === it.id
                    ? <textarea autoFocus className="slide-text shape-text editing" style={style} defaultValue={it.text || ''} aria-label="Text in the shape"
                        onPointerDown={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); } }}
                        onChange={(e) => onChange(it.id, { text: e.target.value || undefined })}
                        onBlur={() => onEdit(null)} />
                    : it.text ? <div className="slide-text shape-text" style={style}>{it.text}</div> : null}
                </div>
              );
            })();
        }
        const at = buildAt.get(it.id);
        const notYet = built !== undefined && at && at > built;
        const arriving = built !== undefined && at && at === built ? `anim-${it.anim}` : '';
        return (
          <div key={it.id} className={`slide-item ${it.type} ${isSel || inGroup ? 'sel' : ''} ${inGroup ? 'in-group' : ''} ${arriving}`} data-item={it.id} data-built={built !== undefined && at ? (notYet ? 'no' : 'yes') : undefined}
            style={{ ...(peers?.has(it.id) ? { ...pos, boxShadow: `0 0 0 ${isSel ? 4 : 2}px ${peers.get(it.id).color}` } : pos), ...(notYet && { visibility: 'hidden' }) }}
            title={peers?.has(it.id) ? `${peers.get(it.id).name} is here` : undefined}
            aria-label={editable ? `${it.type === 'text' ? (it.text ? `Text: ${it.text.slice(0, 40)}` : PLACEHOLDER[it.role] || 'Text box') : boxShape(it) && it.text ? `Shape: ${it.text.slice(0, 40)}` : it.type === 'image' ? (it.alt ? `Picture: ${it.alt.slice(0, 80)}` : 'Picture') : it.type === 'video' ? `Video: ${it.name || ''}` : it.type === 'audio' ? `Sound: ${it.name || ''}` : it.type === 'table' ? 'Table' : it.type === 'chart' ? `Chart: ${it.title || 'Untitled'}` : 'Shape'}` : undefined}
            data-link={!editable && it.link ? '1' : undefined}
            onPointerDown={editable ? (e) => startDrag(e, it) : undefined}
            onDoubleClick={editable && (it.type === 'text' || it.type === 'table' || boxShape(it)) ? () => onEdit(it.id) : undefined}>
            {inner}
            {editable && it.link && <span className="link-badge" title="Has a link (followed when presenting)" aria-hidden="true">🔗</span>}
            {editable && at && <span className="anim-badge" title={`Comes in on click ${at} (${it.anim})`} aria-hidden="true">{at}</span>}
            {isSel && editing !== it.id && HANDLES.map((h) => <span key={h} className={`handle ${h}`} aria-hidden="true" onPointerDown={(e) => startDrag(e, it, h)} />)}
            {isSel && editing !== it.id && <span className="handle rot" title="Drag to rotate (Shift: any angle)" aria-hidden="true" onPointerDown={(e) => startDrag(e, it, 'rot')} />}
          </div>
        );
      })}
      {(live?.guides || []).map((g) => <span key={`${g.axis}${g.at}`} className={`slide-guide ${g.axis}`} aria-hidden="true" style={g.axis === 'x' ? { left: `${g.at}%` } : { top: `${g.at}%` }} />)}
      {masterOn(theme, slide) && <MasterMarks master={theme.master} src={(pid) => `${pictureBase || `/api/files/${deckId}`}/pictures/${pid}`} />}
      {number ? <span className="slide-number" aria-label={`Slide number ${number}`}>{number}</span> : null}
    </div>
  );
}

/** The master's logo and footer, on top of a slide (they can't be selected or moved there). */
function MasterMarks({ master, src }) {
  return <>
    {master.logo && <img className={`slide-logo ${master.corner || 'tr'}`} src={src(master.logo)} alt="Logo" draggable={false} />}
    {master.footer && <span className="slide-footer">{master.footer}</span>}
  </>;
}

/** Theme and logo: the presentation's own colours and font, and a logo and footer on every slide. */
function ThemeDialog({ deck, deckId, slide, parentId, onSave, onClose }) {
  const toast = useToast();
  const now = themeOf(deck);
  const [c, setC] = useState(() => cleanCustom(now));
  const [m, setM] = useState(() => ({ corner: 'tr', footer: '', skipFirst: false, ...(deck.master || {}) }));
  const [busy, setBusy] = useState(false);
  const pick = useRef();
  const preview = { ...cleanCustom(c), master: cleanMaster(m), firstId: deck.slides[0]?.id };
  async function upload(f) {
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return toast('Choose a PNG, JPEG, GIF or WebP picture', 'error');
    setBusy(true);
    try {
      let up;
      try { up = await uploadFile(f, parentId); } catch { up = await uploadFile(f, null); }
      setM((x) => ({ ...x, logo: up.id }));
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  const colour = (k, label) => <label className="field theme-colour"><span>{label}</span><input type="color" value={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.value })} /></label>;
  return (
    <Modal title="Theme and logo" onClose={onClose} wide footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={busy} onClick={() => onSave({ custom: cleanCustom(c), master: cleanMaster(m) })}>Save</button>
    </>}>
      <div className="theme-dialog">
        <div className="theme-form">
          <fieldset><legend>Colours and font</legend>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {Object.entries(THEMES).map(([k, t]) => <button key={k} type="button" className="btn small" title={`Start from ${t.name}`} onClick={() => setC({ ...cleanCustom(t), ...(c.font && { font: c.font }) })}><span className="theme-swatch" style={{ background: t.bg, color: t.text, borderColor: t.accent }}>Aa</span> {t.name}</button>)}
            </div>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{colour('bg', 'Background')}{colour('text', 'Text')}{colour('accent', 'Accent')}</div>
            <label className="field"><span>Font</span>
              <select value={c.font || ''} onChange={(e) => setC({ ...c, font: e.target.value || undefined })}>
                <option value="">The app's font</option>
                {THEME_FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
              </select></label>
          </fieldset>
          <fieldset><legend>On every slide</legend>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              {m.logo ? <><img className="theme-logo-thumb" src={`/api/files/${deckId}/pictures/${m.logo}`} alt="Logo" /><button type="button" className="btn small" onClick={() => setM({ ...m, logo: undefined })}>Remove logo</button></>
                : <button type="button" className="btn small" disabled={busy} onClick={() => pick.current.click()}>{busy ? 'Uploading…' : 'Add a logo…'}</button>}
              <input ref={pick} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
              {m.logo && <select aria-label="Logo corner" value={m.corner} onChange={(e) => setM({ ...m, corner: e.target.value })}>{CORNERS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>}
            </div>
            <label className="field"><span>Footer</span><input value={m.footer || ''} maxLength={120} placeholder="Acme Trading · Confidential" onChange={(e) => setM({ ...m, footer: e.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={!!m.skipFirst} onChange={(e) => setM({ ...m, skipFirst: e.target.checked })} /> Not on the first slide</label>
          </fieldset>
        </div>
        <div className="theme-preview" aria-label="Preview">{slide && <SlideView slide={slide} theme={preview} deckId={deckId} />}</div>
      </div>
    </Modal>
  );
}

/** Full screen: arrows, space, Page Up/Down or a click move; Escape ends. */
/** The speaker's window: opened beside the presentation, kept in step over a BroadcastChannel. */
/** "Update" when the spreadsheet's chart has changed since it was put on the slide. */
function ChartUpdate({ item, onUpdate }) {
  const { state, now } = useChartNow(item);
  if (state === 'ok' && chartChanged(item, now)) return <button type="button" className="tb on" title="The spreadsheet has changed: show its latest figures" onClick={() => onUpdate(now)}>↻ Update chart</button>;
  const note = { ok: 'Up to date', loading: '…', 'no-access': 'Spreadsheet not shared with you', gone: 'Chart deleted in the spreadsheet' }[state];
  return <><span className="muted small" role="status">{note}</span>{state !== 'no-access' && <a className="tb" href={`/sheets/${item.fileId}`} target="_blank" rel="noreferrer">Open spreadsheet</a>}</>;
}

function openPresenterView(deckId, i) {
  window.open(`/slides/${deckId}/presenter?slide=${i}`, `presenter-${deckId}`, 'popup,width=1100,height=720');
}

function Presenter({ deck, theme, deckId, start, onClose: done, rehearse = false }) {
  // Rehearsing: time on each slide (going back adds to it), told to whoever opened us when it ends.
  const timed = useRef([]);
  const since = useRef(Date.now());
  const [tick, setTick] = useState(0);
  const onClose = (n) => {
    if (rehearse) { timed.current.push({ i: iRef.current, ms: Date.now() - since.current }); done(n, timed.current); }
    else done(n);
  };
  // Where we are: slide i, with its first b animated boxes in.
  const [at, setAt] = useState(() => ({ i: firstShown(deck, start), b: 0 }));
  const i = at.i;
  const setI = (v) => setAt((cur) => { const n = typeof v === 'function' ? v(cur.i) : v; return n === cur.i ? cur : { i: n, b: 0 }; });
  const step = (dir) => setAt((cur) => (dir > 0 ? nextPresent(deck, cur) : stepPresent(deck, cur, dir)));
  const [notes, setNotes] = useState(false);
  // Audience Q&A: started (or the one already running) with ❓; the panel shows the link and the questions.
  const [qa, setQa] = useState(null);
  const toastQa = useToast();
  const toggleQa = async () => {
    if (qa) { setQa(null); return; }
    try { setQa((await post(`/slide-qa/decks/${deckId}/start`)).code); } catch (e) { toastQa(e.message, 'error'); }
  };
  // Slides that move on by themselves (P pauses and resumes); moving on yourself starts the wait again.
  const [paused, setPaused] = useState(false);
  const wait = deck.slides[at.i]?.advance || 0;
  useEffect(() => {
    if (!wait || paused) return undefined;
    const t = setTimeout(() => setAt((cur) => nextPresent(deck, cur)), wait * 1000);
    return () => clearTimeout(t);
  }, [at, wait, paused, deck]);
  const [laser, setLaser] = useState(null); // null: off; { x, y } where it points (L turns it on and off)
  const ref = useRef();
  const last = deck.slides.length - 1;
  // The presenter window (if open) follows this one, and can move it.
  const channel = useRef(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const ch = new BroadcastChannel(`nw-present-${deckId}`);
    channel.current = ch;
    ch.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'hello') ch.postMessage({ type: 'deck', deck, theme: deck.theme, i: iRef.current });
      if (m.type === 'go' && Number.isInteger(m.i)) setI(Math.max(0, Math.min(last, m.i))); // the presenter window passes over skipped slides itself
    };
    ch.postMessage({ type: 'deck', deck, theme: deck.theme, i: iRef.current });
    return () => { ch.postMessage({ type: 'end' }); ch.close(); channel.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);
  useEffect(() => { channel.current?.postMessage({ type: 'at', i, b: at.b, of: builds(deck.slides[i]).length }); }, [i, at.b]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { channel.current?.postMessage({ type: 'deck', deck, theme: deck.theme, i: iRef.current }); }, [deck]);
  useEffect(() => {
    const el = ref.current;
    el.focus();
    el.requestFullscreen?.().catch(() => {});
    const onFs = () => { if (!document.fullscreenElement) onClose(iRef.current); };
    document.addEventListener('fullscreenchange', onFs);
    return () => { document.removeEventListener('fullscreenchange', onFs); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const iRef = useRef(i);
  // A new slide: the one before gets its time.
  useEffect(() => {
    if (!rehearse) return;
    const prev = iRef.prev;
    if (prev !== undefined && prev !== i) { timed.current.push({ i: prev, ms: Date.now() - since.current }); since.current = Date.now(); }
    iRef.prev = i;
  }, [i]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!rehearse) return undefined; const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, [rehearse]);
  iRef.current = i;
  const onKey = (e) => {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); step(1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') setI(firstShown(deck, 0));
    else if (e.key === 'End') setI(deck.slides[last].skip ? stepSlide(deck, last, -1) : last);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(i); } // not on to a window opened by ending (the rehearsal summary)
    else if (e.key === 'n' || e.key === 'N') setNotes((v) => !v); // notes on this screen, for a single display
    else if (e.key === 'l' || e.key === 'L') setLaser((v) => (v ? null : { x: -100, y: -100 })); // a laser pointer that follows the mouse
    else if (e.key === 'p' || e.key === 'P') setPaused((v) => !v); // stop (and restart) slides moving on by themselves
  };
  return (
    <div ref={ref} className={`presenter ${laser ? 'lasering' : ''}`} tabIndex={-1} role="dialog" aria-label="Presenting" onKeyDown={onKey} onClick={(e) => {
        // A box with a link: open the web page (in a new tab) or go to that slide; anywhere else moves on.
        const el = e.target.closest?.('[data-link]');
        const it = el && deck.slides[i]?.items.find((x) => x.id === el.dataset.item);
        const t = it && linkTarget(deck, it.link);
        if (t?.url) { window.open(t.url, '_blank', 'noopener,noreferrer'); return; }
        if (t && t.i !== undefined) { setI(t.i); return; }
        step(1);
      }}
      onPointerMove={(e) => { if (laser) setLaser({ x: e.clientX, y: e.clientY }); }}>
      {laser && <span className="laser-dot" role="img" aria-label="Laser pointer" style={{ left: laser.x, top: laser.y }} />}
      <div key={i} className={`presenter-slide ${deck.slides[i]?.transition ? `tr-${deck.slides[i].transition}` : ''}`}><SlideView slide={deck.slides[i]} theme={theme} deckId={deckId} built={at.b} number={numberShown(deck, i) ? i + 1 : null} playing /></div>
      {notes && <div className="presenter-notes" onClick={(e) => e.stopPropagation()}>{deck.slides[i]?.notes || <span className="muted">No notes for this slide</span>}</div>}
      <div className="presenter-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Previous slide" disabled={stepSlide(deck, i, -1) === i && at.b === 0} onClick={() => step(-1)}>‹</button>
        <span aria-live="polite">{i + 1} / {deck.slides.length}</span>
        <button type="button" aria-label="Next slide" disabled={!deck.loop && stepSlide(deck, i, 1) === i && at.b >= builds(deck.slides[i]).length} onClick={() => step(1)}>›</button>
        {wait > 0 && <button type="button" aria-label={paused ? 'Resume moving on by itself' : 'Pause moving on by itself'} aria-pressed={paused} title={`${paused ? 'Paused' : `Moves on after ${wait} s`} (P)`} onClick={() => setPaused((v) => !v)}>{paused ? '▶' : '⏸'}</button>}
        {deck.loop && <span className="muted small" title="Starts again after the last slide">⟳</span>}
        <button type="button" aria-label={laser ? 'Turn off the laser pointer' : 'Laser pointer'} aria-pressed={!!laser} title="Laser pointer (L)" onClick={() => setLaser((v) => (v ? null : { x: -100, y: -100 }))}>●</button>
        <button type="button" aria-label={qa ? 'Hide audience questions' : 'Audience questions'} aria-pressed={!!qa} title="Audience Q&A: people at your company ask and upvote questions at a link" onClick={toggleQa}>❓</button>
        <button type="button" aria-label="End presentation" onClick={() => onClose(i)}>✕</button>
      </div>
      {qa && <QaPanel code={qa} onHide={() => setQa(null)} onEnded={() => setTimeout(() => setQa(null), 1500)} />}
      {rehearse && (() => {
        const total = timed.current.reduce((n, x) => n + x.ms, 0) + (Date.now() - since.current);
        return <div className="rehearse-timer" role="timer" aria-label="Rehearsal timer" data-tick={tick} onClick={(e) => e.stopPropagation()}>
          <span title="On this slide">{clock(Date.now() - since.current)}</span> <span className="muted">· total {clock(total)}</span></div>;
      })()}
    </div>
  );
}

/** "0:42", "12:05", "1:02:09". */
export const clock = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`; };

/** After a rehearsal: how long each slide took, the total, and how it compares with your last one. Kept for this deck. */
function RehearsalSummary({ deck, deckId, timed, onClose }) {
  const toast = useToast();
  const [saved, setSaved] = useState(null);
  const [earlier, setEarlier] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const before = await get(`/slide-qa/rehearsals/${deckId}`);
        setEarlier(before);
        setSaved(await post(`/slide-qa/rehearsals/${deckId}`, { slides: timed.filter((x) => x.ms >= 300) }));
      } catch (e) { toast(e.message, 'error'); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const titleOf = (i) => { const t = deck.slides[i]?.items?.find((x) => x.text)?.text; return t ? String(t).replace(/<[^>]+>/g, ' ').trim().slice(0, 60) : `Slide ${i + 1}`; };
  const last = earlier[0];
  return (
    <Modal title="Rehearsal" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      {!saved ? <p className="muted">…</p> : <>
        <p style={{ marginTop: 0 }}><strong aria-label="Total time">{clock(saved.total_ms)}</strong> in all{last && <span className="muted"> · last time {clock(last.total_ms)} ({Math.abs(saved.total_ms - last.total_ms) < 1000 ? 'the same' : saved.total_ms < last.total_ms ? `${clock(last.total_ms - saved.total_ms)} quicker` : `${clock(saved.total_ms - last.total_ms)} longer`})</span>}</p>
        <table className="rehearsal-table" aria-label="Time on each slide">
          <tbody>{saved.slides.map((x) => <tr key={x.i}><th scope="row">{x.i + 1}. {titleOf(x.i)}</th><td>{clock(x.ms)}</td></tr>)}</tbody>
        </table>
        <p className="muted small">Kept for this presentation (your last {5}), so you can compare next time.</p>
      </>}
    </Modal>
  );
}

/**
 * A line or arrow across its box, drawn at the box's real size so the arrowhead keeps its shape.
 * dir: h → across, hr ← across, v ↓ down, vr ↑ up, d ↘ corner to corner, u ↗ corner to corner.
 */
function LineShape({ arrow, dir, color }) {
  const ref = useRef();
  const [size, setSize] = useState({ w: 100, h: 20 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const { w, h } = size;
  const sw = Math.max(1.5, Math.min(w, h, 400) * 0.06, Math.max(w, h) * 0.008);
  const [x1, y1, x2, y2] = { h: [0, h / 2, w, h / 2], hr: [w, h / 2, 0, h / 2], v: [w / 2, 0, w / 2, h], vr: [w / 2, h, w / 2, 0], d: [0, 0, w, h], u: [0, h, w, 0] }[dir] || [0, h / 2, w, h / 2];
  const head = Math.max(8, sw * 3.5);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const bx = x2 - ux * head, by = y2 - uy * head; // the arrowhead's base
  return (
    <svg ref={ref} className="slide-line" width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ overflow: 'visible' }}>
      <line x1={x1} y1={y1} x2={arrow ? bx : x2} y2={arrow ? by : y2} stroke={color} strokeWidth={sw} strokeLinecap="round" />
      {arrow && <polygon points={`${x2},${y2} ${bx - uy * head * 0.55},${by + ux * head * 0.55} ${bx + uy * head * 0.55},${by - ux * head * 0.55}`} fill={color} />}
    </svg>
  );
}

/** What changed since an earlier version: each slide added, deleted, moved or changed, and how. */
function SlideChanges({ before, after, theme, deckId }) {
  const changes = slideChanges(before, after);
  const quote = (t) => (t ? `“${t.length > 120 ? `${t.slice(0, 120)}…` : t}”` : '');
  const STATUS = { added: 'New slide', removed: 'Deleted', moved: 'Moved', changed: 'Changed' };
  return (
    <div className="slide-changes">
      <p className="muted small changes-summary">{changes.length ? `Since then: ${changes.length} slide${changes.length === 1 ? '' : 's'} added, deleted, moved or changed.` : 'No changes since then.'}</p>
      <ul className="slide-changes-list" style={{ listStyle: 'none', padding: 0 }}>
        {changes.map((c) => {
          const slide = (c.status === 'removed' ? before : after)?.slides?.find((x) => x.id === c.id);
          return (
            <li key={`${c.status}-${c.id}`} className={`row slide-change change-${c.status}`} aria-label={`Slide ${c.n}: ${STATUS[c.status]}`} style={{ alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
              <div style={{ width: 160, flex: 'none' }}>{slide && <SlideView slide={slide} theme={theme} deckId={deckId} />}</div>
              <div className="grow">
                <strong>Slide {c.n}{c.title ? `: ${c.title}` : ''}</strong>
                <span className={`pill ${c.status === 'added' ? 'change-pill-add' : c.status === 'removed' ? 'change-pill-del' : ''}`}>{STATUS[c.status]}{c.was && c.was !== c.n ? ` (was slide ${c.was})` : ''}</span>
                {c.details.length > 0 && (
                  <ul className="small">
                    {c.details.map((d, k) => (
                      <li key={k}>{d.kind === 'add' ? <>Added a {d.what}{d.now ? <> <ins>{quote(d.now)}</ins></> : ''}</>
                        : d.kind === 'del' ? <>Removed a {d.what}{d.was ? <> <del>{quote(d.was)}</del></> : ''}</>
                        : d.kind === 'edit' ? <>{d.what === 'speaker notes' ? 'Speaker notes' : `Text of a ${d.what}`}: {d.was ? <del>{quote(d.was)}</del> : <span className="muted">(empty)</span>} → {d.now ? <ins>{quote(d.now)}</ins> : <span className="muted">(empty)</span>}</>
                        : <>Changed the look of {d.what === 'background' || d.what === 'transition' || d.what === 'skipping' ? `the ${d.what === 'skipping' ? 'skip setting' : d.what}` : `a ${d.what}`}{d.now ? ` ${quote(d.now)}` : ''}</>}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Where a box leads: a web address or another slide of this presentation (or nowhere). */
function LinkDialog({ deck, here, link, onSave, onClose }) {
  const [kind, setKind] = useState(link?.slide ? 'slide' : 'url');
  const [url, setUrl] = useState(link?.url || '');
  const [slide, setSlide] = useState(link?.slide || deck.slides[here + 1]?.id || deck.slides[0]?.id);
  const ok = kind === 'slide' ? !!slide : !!cleanLink({ url }, []);
  return (
    <Modal title="Link" onClose={onClose}
      footer={<>
        {link && <button type="button" className="btn danger" style={{ marginRight: 'auto' }} onClick={() => onSave(null)}>Remove link</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!ok} onClick={() => onSave(kind === 'slide' ? { slide } : { url })}>Save</button>
      </>}>
      <div className="stack">
        <div className="seg" role="radiogroup" aria-label="Link to">
          {[['url', 'A web page'], ['slide', 'A slide']].map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}
        </div>
        {kind === 'url'
          ? <label className="field"><span>Web address or email</span><input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="acme.com/orders" aria-invalid={!!url && !ok} /></label>
          : <label className="field"><span>Slide</span><select value={slide} onChange={(e) => setSlide(e.target.value)}>
              {deck.slides.map((x, k) => <option key={x.id} value={x.id}>{`Slide ${k + 1}${slideTitle(x) ? `: ${slideTitle(x)}` : ''}${k === here ? ' (this one)' : ''}`}</option>)}
            </select></label>}
        <p className="muted small" style={{ margin: 0 }}>While presenting, a click on the box follows the link (web pages open in a new tab) instead of moving on.</p>
      </div>
    </Modal>
  );
}
