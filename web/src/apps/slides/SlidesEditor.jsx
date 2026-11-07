// Presentations: a slide list, a 16:9 canvas with text boxes, pictures and shapes you can move and
// resize, a full-screen presenter, and printing (Save as PDF). Edited together live, like Docs and Sheets.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { get, patch, uploadFile } from '../../api.js';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { jsonFromDeckDoc, applyDeckJson } from '../collabsync.js';
import { useAuth } from '../../App.jsx';
import { useToast, Menu, ConfirmModal, Avatar } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { VersionHistory } from '../VersionHistory.jsx';
import { EditorHeader } from '../editorCommon.jsx';
import { useUndo, undoKey } from '../useUndo.js';
import {
  THEMES, LAYOUTS, newId, clampBox, moveBox, resizeBox, addSlide, duplicateSlide, removeSlide, moveSlide,
  updateItem, addItem, removeItem, restack, pictureBox,
  TRANSITIONS, setSlide, stepSlide, firstShown, newTable, resizeTable, setCell } from './slidemath.js';

const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 54, 64, 72, 96];
const TEXT_COLORS = [['', 'Theme text'], ['accent', 'Theme accent'], ['#202124', 'Black'], ['#ffffff', 'White'], ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#1a73e8', 'Blue'], ['#8430ce', 'Purple']];
const FILLS = [['accent', 'Theme accent'], ['text', 'Theme text'], ['#e8f0fe', 'Light blue'], ['#e6f4ea', 'Light green'], ['#fef7e0', 'Light yellow'], ['#fce8e6', 'Light red'], ['#1a73e8', 'Blue'], ['#188038', 'Green'], ['#c5221f', 'Red'], ['#202124', 'Black'], ['#ffffff', 'White']];
const BACKGROUNDS = [['', 'Theme background'], ['#ffffff', 'White'], ['#f1f3f4', 'Light grey'], ['#e8f0fe', 'Light blue'], ['#fef7e0', 'Light yellow'], ['#202124', 'Black'], ['#0b57d0', 'Blue']];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const PEOPLE_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#8430ce', '#00796b', '#c2185b', '#5f6368'];
const colorFor = (id) => PEOPLE_COLORS[[...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % PEOPLE_COLORS.length];
const PLACEHOLDER = { title: 'Click to add title', subtitle: 'Click to add subtitle', body: 'Click to add text' };

export default function SlidesEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [file, setFile] = useState(null);
  const [deck, setDeck] = useState(null);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null); // item id
  const [editing, setEditing] = useState(null);   // item id whose text is being typed
  const [presenting, setPresenting] = useState(null); // slide index, or null
  const [dialog, setDialog] = useState(null);
  const deckRef = useRef(null);
  const pictureInput = useRef();
  const readOnly = file?.role === 'viewer';
  const [status, setStatus] = useState('connecting');
  const [others, setOthers] = useState([]);
  const [{ ydoc, provider }, setLink] = useState({});

  // The presentation is shared live (Yjs): slides and boxes merge one by one.
  useEffect(() => {
    let alive = true;
    get(`/files/${id}`).then((f) => {
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
  const item = slide?.items.find((it) => it.id === selected) || null;
  const theme = THEMES[deck?.theme] || THEMES.light;
  // The latest deck (a slide may have just been added or removed in this same click).
  const goTo = (i) => { setCurrent(Math.max(0, Math.min(deckRef.current.slides.length - 1, i))); setSelected(null); setEditing(null); };

  // Keyboard on the canvas: Delete removes, arrows nudge (Shift: further), Escape deselects.
  function onCanvasKey(e) {
    if (editing || readOnly) return;
    const u = undoKey(e);
    if (u) { e.preventDefault(); history[u](); return; }
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
    else if (e.key === 'Enter' && item.type === 'text') { e.preventDefault(); setEditing(item.id); }
  }

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

  if (!deck) return <div className="editor-page"><EditorHeader icon="slides" file={null} status="saved" /></div>;
  const people = [...new Map(others.map((p) => [p.id, p])).values()].filter((p) => p.id !== user.id);
  const peers = new Map(others.filter((p) => p.id !== user.id && p.sel?.slide === slide.id && p.sel.item).map((p) => [p.sel.item, p]));

  const setItem = (c) => item && change((d) => updateItem(d, slideIndex, item.id, c));
  const slideAction = (fn) => () => change(fn);

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
          { label: 'Version history', icon: 'clock', onClick: () => setDialog('history') },
          { label: 'Print or save as PDF', icon: 'print', onClick: () => window.print() },
          { label: 'Download as PowerPoint (.pptx)', icon: 'download', onClick: () => { window.location.href = `/api/files/${id}/export`; } },
          ...(!readOnly ? ['-', ...Object.entries(THEMES).map(([k, t]) => ({ label: `Theme: ${t.name}${deck.theme === k ? ' ✓' : ''}`, onClick: () => change((d) => ({ ...d, theme: k })) }))] : []),
        ]}
      />
      {status === 'offline' && <div className="banner warn">You're offline. Keep editing: your changes are kept here and sync when the connection is back.</div>}
      {readOnly && <div className="banner">View only. Ask {file.owner_name} for edit access.</div>}
      {!readOnly && (
        <div className="slides-toolbar" role="toolbar" aria-label="Slide tools">
          <button type="button" className="tb" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>↶</button>
          <button type="button" className="tb" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!history.canRedo} onClick={history.redo}>↷</button>
          <span className="sep" />
          <Menu align="left" trigger={(p) => <button type="button" className="tb" {...p} aria-label="New slide" title="New slide"><Icon name="plus" size={18} /> Slide</button>}
            items={LAYOUTS.map(([k, label]) => ({ label, onClick: () => { change((d) => addSlide(d, slideIndex, k)); goTo(slideIndex + 1); } }))} />
          <span className="sep" />
          <button type="button" className="tb" onClick={() => insert({ type: 'text', role: 'body', x: 30, y: 40, w: 40, h: 14, text: '', size: 24 })}>Text box</button>
          <button type="button" className="tb" onClick={() => pictureInput.current.click()}>Picture</button>
          <button type="button" className="tb" onClick={() => insert({ type: 'table', x: 15, y: 25, w: 70, h: 40, size: 18, header: true, cells: newTable(3, 3) })}>Table</button>
          <Menu align="left" trigger={(p) => <button type="button" className="tb" {...p}>Shape ▾</button>} items={[
            { label: 'Rectangle', onClick: () => insert({ type: 'shape', shape: 'rect', x: 35, y: 35, w: 30, h: 30, fill: 'accent' }) },
            { label: 'Rounded rectangle', onClick: () => insert({ type: 'shape', shape: 'round', x: 35, y: 35, w: 30, h: 30, fill: 'accent' }) },
            { label: 'Ellipse', onClick: () => insert({ type: 'shape', shape: 'ellipse', x: 40, y: 30, w: 20, h: 36, fill: 'accent' }) },
            { label: 'Line', onClick: () => insert({ type: 'shape', shape: 'line', dir: 'h', x: 30, y: 46, w: 40, h: 8, fill: 'text' }) },
            { label: 'Arrow', onClick: () => insert({ type: 'shape', shape: 'arrow', dir: 'h', x: 30, y: 46, w: 40, h: 8, fill: 'accent' }) },
          ]} />
          <input ref={pictureInput} type="file" accept="image/*" hidden onChange={(e) => { insertPicture(e.target.files[0]); e.target.value = ''; }} />
          <span className="sep" />
          {item?.type === 'text' && <>
            <select className="tb-select" aria-label="Text size" value={item.size || 24} onChange={(e) => setItem({ size: Number(e.target.value) })}>
              {[...new Set([...SIZES, item.size || 24])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" className={`tb ${item.bold ? 'on' : ''}`} aria-pressed={!!item.bold} aria-label="Bold" onClick={() => setItem({ bold: !item.bold })}><b>B</b></button>
            <button type="button" className={`tb ${item.italic ? 'on' : ''}`} aria-pressed={!!item.italic} aria-label="Italic" onClick={() => setItem({ italic: !item.italic })}><i>I</i></button>
            <select className="tb-select" aria-label="Text colour" value={item.color || ''} onChange={(e) => setItem({ color: e.target.value || undefined })}>
              {TEXT_COLORS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
            </select>
            {['left', 'center', 'right'].map((a) => (
              <button key={a} type="button" className={`tb ${(item.align || 'left') === a ? 'on' : ''}`} aria-pressed={(item.align || 'left') === a}
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
          {item && <>
            <button type="button" className="tb" aria-label="Bring to front" title="Bring to front" onClick={() => change((d) => restack(d, slideIndex, item.id, 1))}>⤒</button>
            <button type="button" className="tb" aria-label="Send to back" title="Send to back" onClick={() => change((d) => restack(d, slideIndex, item.id, -1))}>⤓</button>
            <button type="button" className="tb" aria-label="Delete" title="Delete (Del)" onClick={() => { change((d) => removeItem(d, slideIndex, item.id)); setSelected(null); }}><Icon name="trash" size={18} /></button>
          </>}
          {!item && (
            <select className="tb-select" aria-label="Slide background" value={slide.bg || ''} onChange={(e) => change((d) => ({ ...d, slides: d.slides.map((s, i) => (i === slideIndex ? { ...s, bg: e.target.value || undefined } : s)) }))}>
              {BACKGROUNDS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
            </select>
          )}
          <div className="grow" />
          <button type="button" className="btn small primary" onClick={() => setPresenting(slideIndex)}><Icon name="slides" size={16} /> Present</button>
          <button type="button" className="btn small" title="Present, with your notes, the next slide and a timer in a second window" onClick={() => { openPresenterView(id, slideIndex); setPresenting(slideIndex); }}>Presenter view</button>
        </div>
      )}
      {readOnly && <div className="slides-toolbar"><div className="grow" /><button type="button" className="btn small primary" onClick={() => setPresenting(slideIndex)}><Icon name="slides" size={16} /> Present</button>
          <button type="button" className="btn small" title="Present, with your notes, the next slide and a timer in a second window" onClick={() => { openPresenterView(id, slideIndex); setPresenting(slideIndex); }}>Presenter view</button></div>}

      <div className="slides-body">
        <ol className="slide-list" aria-label="Slides">
          {deck.slides.map((s, i) => (
            <li key={s.id} className={`${i === slideIndex ? 'on' : ''} ${s.skip ? 'skipped' : ''}`}>
              <span className="num" aria-hidden="true">{i + 1}{s.transition && <span className="thumb-mark" title={`Transition: ${s.transition}`}>✦</span>}{s.skip && <span className="thumb-mark" title="Skipped when presenting">⊘</span>}</span>
              <button type="button" className="thumb" aria-label={`Slide ${i + 1}`} aria-current={i === slideIndex ? 'true' : undefined} onClick={() => goTo(i)}>
                <SlideView slide={s} theme={theme} deckId={id} />
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
                  { label: 'Delete slide', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete-slide', index: i }) },
                ]} />
              )}
            </li>
          ))}
        </ol>
        <div className="slide-stage" tabIndex={-1} onPointerDown={(e) => { if (e.target === e.currentTarget) { setSelected(null); setEditing(null); } }}>
          <SlideView slide={slide} theme={theme} deckId={id} editable={!readOnly} selected={selected} editing={editing} peers={peers}
            onSelect={(itemId) => { setSelected(itemId); if (itemId !== editing) setEditing(null); }}
            onEdit={setEditing}
            onChange={(itemId, c) => change((d) => updateItem(d, slideIndex, itemId, c))} />
          <p className="muted small slide-count">Slide {slideIndex + 1} of {deck.slides.length}</p>
          {readOnly ? (slide.notes && <div className="slide-notes read"><span className="muted small">Speaker notes</span><p>{slide.notes}</p></div>) : (
            <label className="slide-notes"><span className="muted small">Speaker notes</span>
              <textarea rows={3} value={slide.notes || ''} placeholder="Notes for this slide: only you see them while presenting" maxLength={20000}
                onChange={(e) => { const notes = e.target.value; change((d) => ({ ...d, slides: d.slides.map((x, i) => (i === slideIndex ? { ...x, notes: notes || undefined } : x)) })); }} />
            </label>
          )}
        </div>
      </div>

      <div className="print-deck" aria-hidden="true">
        {deck.slides.map((s) => <div key={s.id} className="print-slide"><SlideView slide={s} theme={theme} deckId={id} /></div>)}
      </div>
      {presenting !== null && <Presenter deck={deck} theme={theme} deckId={id} start={presenting} onClose={(i) => { setPresenting(null); goTo(i); }} />}
      {dialog === 'share' && <ShareDialog file={file} onClose={() => setDialog(null)} />}
      {dialog === 'history' && <VersionHistory file={file} canEdit={!readOnly} onClose={() => setDialog(null)} renderPreview={(content) => (
        <div className="deck-preview">{(content?.slides || []).map((sl, n) => <div key={sl.id || n} className="deck-preview-slide"><span className="muted small">{n + 1}</span><SlideView slide={sl} theme={THEMES[content.theme] || THEMES.light} deckId={file.id} /></div>)}</div>
      )} />}
      {dialog?.type === 'delete-slide' && (
        <ConfirmModal title={`Delete slide ${dialog.index + 1}?`} confirm="Delete" message="The slide and everything on it is removed. Version history can bring it back."
          onClose={() => setDialog(null)} onConfirm={() => { change((d) => removeSlide(d, dialog.index)); goTo(Math.min(dialog.index, deck.slides.length - 2)); setDialog(null); }} />
      )}
    </div>
  );
}

const colorOf = (v, theme, fallback) => (v === 'accent' ? theme.accent : v === 'text' ? theme.text : v || fallback);

/**
 * One slide. Sizes are in percent of the slide, text in 1/1000 of its width, so the same slide
 * draws the same in a thumbnail, the editor, full screen and on paper.
 */
export function SlideView({ slide, theme, deckId, editable, selected, editing, onSelect, onEdit, onChange, peers }) {
  const ref = useRef();
  const [live, setLive] = useState(null); // { id, box } while dragging

  function startDrag(e, it, handle = null) {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    onSelect(it.id);
    if (editing === it.id && !handle) return; // typing: let the cursor move in the text
    const rect = ref.current.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    const ratio = it.type === 'image' ? it.w / it.h : null;
    let box = null, moved = false;
    const move = (m) => {
      const dx = ((m.clientX - x0) / rect.width) * 100, dy = ((m.clientY - y0) / rect.height) * 100;
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 3) return;
      moved = true;
      box = handle ? resizeBox(it, handle, dx, dy, m.shiftKey ? null : ratio) : moveBox(it, dx, dy);
      setLive({ id: it.id, box });
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
    <div ref={ref} className={`slide ${editable ? 'editable' : ''}`} style={{ background: slide.bg || theme.bg, color: theme.text }} role={editable ? 'group' : undefined} aria-label={editable ? 'Slide' : undefined}>
      {slide.items.map((it) => {
        const box = live?.id === it.id ? live.box : it;
        const pos = { left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` };
        const isSel = editable && selected === it.id;
        let inner = null;
        if (it.type === 'text') {
          const style = { fontSize: `calc(${it.size || 24} * 0.1cqw)`, fontWeight: it.bold ? 700 : 400, fontStyle: it.italic ? 'italic' : 'normal', textAlign: it.align || 'left', color: colorOf(it.color, theme, theme.text) };
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
          inner = <img src={`/api/files/${deckId}/pictures/${it.fileId}`} alt={it.name || ''} draggable={false}
            onError={(e) => { const direct = `/api/files/${it.fileId}/raw`; if (!e.currentTarget.src.endsWith(direct)) e.currentTarget.src = direct; }} />;
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
        } else if (it.type === 'shape') {
          inner = it.shape === 'line' || it.shape === 'arrow'
            ? <LineShape arrow={it.shape === 'arrow'} dir={it.dir || 'h'} color={colorOf(it.fill, theme, theme.accent)} />
            : <div className={`slide-shape ${it.shape}`} style={{ background: colorOf(it.fill, theme, theme.accent) }} />;
        }
        return (
          <div key={it.id} className={`slide-item ${it.type} ${isSel ? 'sel' : ''}`} data-item={it.id}
            style={peers?.has(it.id) ? { ...pos, boxShadow: `0 0 0 ${isSel ? 4 : 2}px ${peers.get(it.id).color}` } : pos}
            title={peers?.has(it.id) ? `${peers.get(it.id).name} is here` : undefined}
            aria-label={editable ? `${it.type === 'text' ? (it.text ? `Text: ${it.text.slice(0, 40)}` : PLACEHOLDER[it.role] || 'Text box') : it.type === 'image' ? 'Picture' : it.type === 'table' ? 'Table' : 'Shape'}` : undefined}
            onPointerDown={editable ? (e) => startDrag(e, it) : undefined}
            onDoubleClick={editable && (it.type === 'text' || it.type === 'table') ? () => onEdit(it.id) : undefined}>
            {inner}
            {isSel && editing !== it.id && HANDLES.map((h) => <span key={h} className={`handle ${h}`} aria-hidden="true" onPointerDown={(e) => startDrag(e, it, h)} />)}
          </div>
        );
      })}
    </div>
  );
}

/** Full screen: arrows, space, Page Up/Down or a click move; Escape ends. */
/** The speaker's window: opened beside the presentation, kept in step over a BroadcastChannel. */
function openPresenterView(deckId, i) {
  window.open(`/slides/${deckId}/presenter?slide=${i}`, `presenter-${deckId}`, 'popup,width=1100,height=720');
}

function Presenter({ deck, theme, deckId, start, onClose }) {
  const [i, setI] = useState(() => firstShown(deck, start));
  const [notes, setNotes] = useState(false);
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
  useEffect(() => { channel.current?.postMessage({ type: 'at', i }); }, [i]);
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
  iRef.current = i;
  const onKey = (e) => {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); setI((x) => stepSlide(deck, x, 1)); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); setI((x) => stepSlide(deck, x, -1)); }
    else if (e.key === 'Home') setI(firstShown(deck, 0));
    else if (e.key === 'End') setI(deck.slides[last].skip ? stepSlide(deck, last, -1) : last);
    else if (e.key === 'Escape') { e.preventDefault(); onClose(i); }
    else if (e.key === 'n' || e.key === 'N') setNotes((v) => !v); // notes on this screen, for a single display
  };
  return (
    <div ref={ref} className="presenter" tabIndex={-1} role="dialog" aria-label="Presenting" onKeyDown={onKey} onClick={() => setI((x) => stepSlide(deck, x, 1))}>
      <div key={i} className={`presenter-slide ${deck.slides[i]?.transition ? `tr-${deck.slides[i].transition}` : ''}`}><SlideView slide={deck.slides[i]} theme={theme} deckId={deckId} /></div>
      {notes && <div className="presenter-notes" onClick={(e) => e.stopPropagation()}>{deck.slides[i]?.notes || <span className="muted">No notes for this slide</span>}</div>}
      <div className="presenter-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Previous slide" disabled={stepSlide(deck, i, -1) === i} onClick={() => setI(stepSlide(deck, i, -1))}>‹</button>
        <span aria-live="polite">{i + 1} / {deck.slides.length}</span>
        <button type="button" aria-label="Next slide" disabled={stepSlide(deck, i, 1) === i} onClick={() => setI(stepSlide(deck, i, 1))}>›</button>
        <button type="button" aria-label="End presentation" onClick={() => onClose(i)}>✕</button>
      </div>
    </div>
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
