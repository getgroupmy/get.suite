// Presentations: a slide list, a 16:9 canvas with text boxes, pictures and shapes you can move and
// resize, a full-screen presenter, and printing (Save as PDF). Saved like Docs and Sheets.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, patch, onLive, uploadFile } from '../../api.js';
import { useAuth } from '../../App.jsx';
import { useToast, Menu, ConfirmModal } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { ShareDialog } from '../drive/Drive.jsx';
import { useAutosave, EditorHeader } from '../editorCommon.jsx';
import {
  THEMES, LAYOUTS, newId, clampBox, moveBox, resizeBox, addSlide, duplicateSlide, removeSlide, moveSlide,
  updateItem, addItem, removeItem, restack, pictureBox,
} from './slidemath.js';

const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 54, 64, 72, 96];
const TEXT_COLORS = [['', 'Theme text'], ['accent', 'Theme accent'], ['#202124', 'Black'], ['#ffffff', 'White'], ['#c5221f', 'Red'], ['#e37400', 'Orange'], ['#188038', 'Green'], ['#1a73e8', 'Blue'], ['#8430ce', 'Purple']];
const FILLS = [['accent', 'Theme accent'], ['#e8f0fe', 'Light blue'], ['#e6f4ea', 'Light green'], ['#fef7e0', 'Light yellow'], ['#fce8e6', 'Light red'], ['#1a73e8', 'Blue'], ['#188038', 'Green'], ['#c5221f', 'Red'], ['#202124', 'Black'], ['#ffffff', 'White']];
const BACKGROUNDS = [['', 'Theme background'], ['#ffffff', 'White'], ['#f1f3f4', 'Light grey'], ['#e8f0fe', 'Light blue'], ['#fef7e0', 'Light yellow'], ['#202124', 'Black'], ['#0b57d0', 'Blue']];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
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
  const save = useAutosave(id);
  const readOnly = file?.role === 'viewer';

  const load = useCallback(async () => {
    const { file, content } = await get(`/files/${id}/content`);
    setFile(file);
    save.setVersion(file.version);
    deckRef.current = content;
    setDeck(content);
    document.title = `${file.name} · Slides`;
  }, [id, save]);

  useEffect(() => {
    load().catch((e) => { toast(e.message, 'error'); navigate('/drive'); });
    return () => { document.title = 'Workspace'; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Someone else saved (or a version was restored): load it unless we have unsaved changes.
  useEffect(() => onLive(async (m) => {
    if (m.type !== 'content-changed' || m.id !== id || m.by === user.id) return;
    if (save.isDirty() || editing) { save.markConflict(m.by_name); return; }
    await load();
    toast(`${m.by_name} updated this presentation`);
  }), [id, user.id, save, editing, load, toast]);

  const commit = useCallback((next) => {
    if (readOnly) return;
    deckRef.current = next;
    setDeck(next);
    save.changed(() => deckRef.current);
  }, [readOnly, save]);
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

  if (!deck) return <div className="editor-page"><EditorHeader icon="slides" file={null} status="saved" /></div>;

  const setItem = (c) => item && change((d) => updateItem(d, slideIndex, item.id, c));
  const slideAction = (fn) => () => change(fn);

  return (
    <div className="editor-page slides-page">
      <EditorHeader
        icon="slides" file={file} status={save.status}
        onRename={async (name) => setFile(await patch(`/files/${id}`, { name }))}
        onShare={() => setDialog('share')}
        menu={[
          { label: 'Present', icon: 'slides', onClick: () => setPresenting(slideIndex) },
          { label: 'Print or save as PDF', icon: 'print', onClick: () => window.print() },
          ...(!readOnly ? ['-', ...Object.entries(THEMES).map(([k, t]) => ({ label: `Theme: ${t.name}${deck.theme === k ? ' ✓' : ''}`, onClick: () => change((d) => ({ ...d, theme: k })) }))] : []),
        ]}
      />
      {save.conflict && (
        <div className="banner warn">
          {save.conflict} changed this presentation while you were editing.
          <button className="btn small" onClick={async () => { save.resolve(); await load(); }}>Load their version</button>
          <button className="btn small" onClick={() => save.forceSave(deckRef.current)}>Keep mine</button>
        </div>
      )}
      {readOnly && <div className="banner">View only. Ask {file.owner_name} for edit access.</div>}
      {!readOnly && (
        <div className="slides-toolbar" role="toolbar" aria-label="Slide tools">
          <Menu align="left" trigger={(p) => <button type="button" className="tb" {...p} aria-label="New slide" title="New slide"><Icon name="plus" size={18} /> Slide</button>}
            items={LAYOUTS.map(([k, label]) => ({ label, onClick: () => { change((d) => addSlide(d, slideIndex, k)); goTo(slideIndex + 1); } }))} />
          <span className="sep" />
          <button type="button" className="tb" onClick={() => insert({ type: 'text', role: 'body', x: 30, y: 40, w: 40, h: 14, text: '', size: 24 })}>Text box</button>
          <button type="button" className="tb" onClick={() => pictureInput.current.click()}>Picture</button>
          <Menu align="left" trigger={(p) => <button type="button" className="tb" {...p}>Shape ▾</button>} items={[
            { label: 'Rectangle', onClick: () => insert({ type: 'shape', shape: 'rect', x: 35, y: 35, w: 30, h: 30, fill: 'accent' }) },
            { label: 'Rounded rectangle', onClick: () => insert({ type: 'shape', shape: 'round', x: 35, y: 35, w: 30, h: 30, fill: 'accent' }) },
            { label: 'Ellipse', onClick: () => insert({ type: 'shape', shape: 'ellipse', x: 40, y: 30, w: 20, h: 36, fill: 'accent' }) },
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
        </div>
      )}
      {readOnly && <div className="slides-toolbar"><div className="grow" /><button type="button" className="btn small primary" onClick={() => setPresenting(slideIndex)}><Icon name="slides" size={16} /> Present</button></div>}

      <div className="slides-body">
        <ol className="slide-list" aria-label="Slides">
          {deck.slides.map((s, i) => (
            <li key={s.id} className={i === slideIndex ? 'on' : ''}>
              <span className="num" aria-hidden="true">{i + 1}</span>
              <button type="button" className="thumb" aria-label={`Slide ${i + 1}`} aria-current={i === slideIndex ? 'true' : undefined} onClick={() => goTo(i)}>
                <SlideView slide={s} theme={theme} deckId={id} />
              </button>
              {!readOnly && (
                <Menu trigger={(p) => <button type="button" className="icon-btn thumb-menu" aria-label={`Options for slide ${i + 1}`} {...p}><Icon name="more" size={16} /></button>} items={[
                  { label: 'Duplicate', onClick: slideAction((d) => duplicateSlide(d, i)) },
                  i > 0 && { label: 'Move up', onClick: () => { change((d) => moveSlide(d, i, i - 1)); goTo(i - 1); } },
                  i < deck.slides.length - 1 && { label: 'Move down', onClick: () => { change((d) => moveSlide(d, i, i + 1)); goTo(i + 1); } },
                  '-',
                  { label: 'Delete slide', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete-slide', index: i }) },
                ]} />
              )}
            </li>
          ))}
        </ol>
        <div className="slide-stage" tabIndex={-1} onPointerDown={(e) => { if (e.target === e.currentTarget) { setSelected(null); setEditing(null); } }}>
          <SlideView slide={slide} theme={theme} deckId={id} editable={!readOnly} selected={selected} editing={editing}
            onSelect={(itemId) => { setSelected(itemId); if (itemId !== editing) setEditing(null); }}
            onEdit={setEditing}
            onChange={(itemId, c) => change((d) => updateItem(d, slideIndex, itemId, c))} />
          <p className="muted small slide-count">Slide {slideIndex + 1} of {deck.slides.length}</p>
        </div>
      </div>

      <div className="print-deck" aria-hidden="true">
        {deck.slides.map((s) => <div key={s.id} className="print-slide"><SlideView slide={s} theme={theme} deckId={id} /></div>)}
      </div>
      {presenting !== null && <Presenter deck={deck} theme={theme} deckId={id} start={presenting} onClose={(i) => { setPresenting(null); goTo(i); }} />}
      {dialog === 'share' && <ShareDialog file={file} onClose={() => setDialog(null)} />}
      {dialog?.type === 'delete-slide' && (
        <ConfirmModal title={`Delete slide ${dialog.index + 1}?`} confirm="Delete" message="The slide and everything on it is removed. Version history can bring it back."
          onClose={() => setDialog(null)} onConfirm={() => { change((d) => removeSlide(d, dialog.index)); goTo(Math.min(dialog.index, deck.slides.length - 2)); setDialog(null); }} />
      )}
    </div>
  );
}

const colorOf = (v, theme, fallback) => (v === 'accent' ? theme.accent : v || fallback);

/**
 * One slide. Sizes are in percent of the slide, text in 1/1000 of its width, so the same slide
 * draws the same in a thumbnail, the editor, full screen and on paper.
 */
function SlideView({ slide, theme, deckId, editable, selected, editing, onSelect, onEdit, onChange }) {
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
          inner = <img src={`/api/files/${deckId}/pictures/${it.fileId}`} alt={it.name || ''} draggable={false} />;
        } else if (it.type === 'shape') {
          inner = <div className={`slide-shape ${it.shape}`} style={{ background: colorOf(it.fill, theme, theme.accent) }} />;
        }
        return (
          <div key={it.id} className={`slide-item ${it.type} ${isSel ? 'sel' : ''}`} style={pos} data-item={it.id}
            aria-label={editable ? `${it.type === 'text' ? (it.text ? `Text: ${it.text.slice(0, 40)}` : PLACEHOLDER[it.role] || 'Text box') : it.type === 'image' ? 'Picture' : 'Shape'}` : undefined}
            onPointerDown={editable ? (e) => startDrag(e, it) : undefined}
            onDoubleClick={editable && it.type === 'text' ? () => onEdit(it.id) : undefined}>
            {inner}
            {isSel && editing !== it.id && HANDLES.map((h) => <span key={h} className={`handle ${h}`} aria-hidden="true" onPointerDown={(e) => startDrag(e, it, h)} />)}
          </div>
        );
      })}
    </div>
  );
}

/** Full screen: arrows, space, Page Up/Down or a click move; Escape ends. */
function Presenter({ deck, theme, deckId, start, onClose }) {
  const [i, setI] = useState(start);
  const ref = useRef();
  const last = deck.slides.length - 1;
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
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); setI((x) => Math.min(last, x + 1)); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Home') setI(0);
    else if (e.key === 'End') setI(last);
    else if (e.key === 'Escape') { e.preventDefault(); onClose(i); }
  };
  return (
    <div ref={ref} className="presenter" tabIndex={-1} role="dialog" aria-label="Presenting" onKeyDown={onKey} onClick={() => setI((x) => Math.min(last, x + 1))}>
      <div className="presenter-slide"><SlideView slide={deck.slides[i]} theme={theme} deckId={deckId} /></div>
      <div className="presenter-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Previous slide" disabled={i === 0} onClick={() => setI(i - 1)}>‹</button>
        <span aria-live="polite">{i + 1} / {deck.slides.length}</span>
        <button type="button" aria-label="Next slide" disabled={i === last} onClick={() => setI(i + 1)}>›</button>
        <button type="button" aria-label="End presentation" onClick={() => onClose(i)}>✕</button>
      </div>
    </div>
  );
}
