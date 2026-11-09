// Pictures in cells (Sheets): what an IMAGE cell shows, and the window that puts one in from your
// computer or from Drive. The picture is kept in Drive; the cell holds =IMAGE("drive:<id>", …).
import { useRef, useState } from 'react';
import { Modal, useToast } from '../../components/ui.jsx';
import DrivePicker from '../../components/DrivePicker.jsx';
import { uploadFile } from '../../api.js';
import { imageFormula } from './formula.js';

const PICTURE_TYPES = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;

/**
 * An IMAGE cell's picture. `base`: where the file's pictures are served (/api/files/<id>). Someone else's
 * new picture can arrive a moment before the spreadsheet is saved with it, so a failed load is tried again.
 */
export function CellPicture({ image, base, label }) {
  const [tries, setTries] = useState(0);
  const style = image.mode === 4 ? { width: image.w, height: image.h } : undefined;
  const src = `${base}/pictures/${image.id}${tries ? `?try=${tries}` : ''}`;
  return <img className={`cell-img mode-${image.mode}`} src={src} alt={label || 'Picture'} style={style} draggable={false}
    onError={() => { if (tries < 4) setTimeout(() => setTries((t) => t + 1), 1000 * (tries + 1)); }} />;
}

export function PictureCellDialog({ cell, parentId, onPick, onClose }) {
  const toast = useToast();
  const [mode, setMode] = useState(1);
  const [h, setH] = useState(80);
  const [w, setW] = useState(120);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const input = useRef();
  const okSize = mode !== 4 || (h >= 8 && h <= 1000 && w >= 8 && w <= 1000);
  const done = (id) => onPick(imageFormula(id, mode, h, w));
  const upload = async (f) => {
    if (!f) return;
    if (!PICTURE_TYPES.test(f.type)) { toast('Choose a picture (PNG, JPEG, GIF or WebP)', 'error'); return; }
    setBusy(true);
    try {
      let up;
      try { up = await uploadFile(f, parentId || null); } catch { up = await uploadFile(f, null); }
      done(up.id);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  if (picking) {
    return <DrivePicker title="Picture from Drive" accept={(x) => x.kind === 'file' && PICTURE_TYPES.test(x.mime || '')} empty="No pictures found."
      onClose={() => setPicking(false)} onPick={(f) => done(f.id)} />;
  }
  return (
    <Modal title={`Picture in cell ${cell}`} onClose={onClose}>
      <div className="stack">
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
          <legend className="small muted" style={{ marginBottom: 6 }}>Size</legend>
          {[[1, 'Fit the cell'], [2, 'Stretch to fill the cell'], [3, 'Its own size (the row grows)'], [4, 'A size I choose']].map(([m, label]) => (
            <label key={m} className="check"><input type="radio" name="pic-size" checked={mode === m} onChange={() => setMode(m)} /> {label}</label>
          ))}
          {mode === 4 && (
            <div className="row" style={{ gap: 12, paddingLeft: 24 }}>
              <label className="field"><span>Height (pixels)</span><input type="number" min={8} max={1000} value={h} onChange={(e) => setH(Number(e.target.value))} /></label>
              <label className="field"><span>Width (pixels)</span><input type="number" min={8} max={1000} value={w} onChange={(e) => setW(Number(e.target.value))} /></label>
            </div>
          )}
        </fieldset>
        <p className="muted small" style={{ margin: 0 }}>Everyone who can open the spreadsheet sees it. It's kept in your Drive.</p>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden aria-label="Picture file" onChange={(e) => upload(e.target.files?.[0])} />
        <div className="row end" style={{ gap: 8 }}>
          <button type="button" className="btn" disabled={!okSize || busy} onClick={() => setPicking(true)}>Choose from Drive</button>
          <button type="button" className="btn primary" disabled={!okSize || busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : 'Upload from computer'}</button>
        </div>
      </div>
    </Modal>
  );
}
