// Drive → New → Scan to PDF: photos of paper (receipts, signed forms, notes) taken with the phone's
// camera, or chosen from its pictures, become one PDF in the folder you're in. Each photo is made
// smaller (sharp enough to read, light enough to send), optionally black and white like a scanner,
// and the PDF is put together in the browser (scanpdf.js) and uploaded like any file.
import { useRef, useState } from 'react';
import { Modal, useToast } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { jpegsToPdf } from './scanpdf.js';

const LONGEST = 1800; // pixels on the long side

/** A photo as a page: { jpeg, width, height, url } (url: a preview). */
async function toPage(file, bw) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, LONGEST / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale), height = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, width, height);
  x.drawImage(bmp, 0, 0, width, height);
  if (bw) {
    // Grey, with the contrast raised so paper goes white and ink goes black, like a scanner.
    const img = x.getImageData(0, 0, width, height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = Math.max(0, Math.min(255, (g - 128) * 1.8 + 150));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    x.putImageData(img, 0, 0);
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  return { jpeg: new Uint8Array(await blob.arrayBuffer()), width, height, url: URL.createObjectURL(blob) };
}

export default function ScanDialog({ onClose, onDone }) {
  const toast = useToast();
  const camera = useRef(), pictures = useRef();
  const [photos, setPhotos] = useState([]); // the original files, in order
  const [pages, setPages] = useState([]);
  const [bw, setBw] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(`Scan ${new Date().toISOString().slice(0, 10)}`);
  const redo = async (files, blackWhite) => {
    setBusy(true);
    try { setPages(await Promise.all(files.map((f) => toPage(f, blackWhite)))); } catch { toast('That picture couldn’t be read', 'error'); }
    setBusy(false);
  };
  const add = (list) => { const files = [...photos, ...list].slice(0, 30); setPhotos(files); redo(files, bw); };
  const remove = (i) => { const files = photos.filter((_, j) => j !== i); setPhotos(files); setPages(pages.filter((_, j) => j !== i)); };
  const move = (i, d) => {
    const j = i + d; if (j < 0 || j >= photos.length) return;
    const swap = (l) => { const c = [...l]; [c[i], c[j]] = [c[j], c[i]]; return c; };
    setPhotos(swap(photos)); setPages(swap(pages));
  };
  const save = () => {
    const pdf = jpegsToPdf(pages, { title: name });
    const fileName = /\.pdf$/i.test(name.trim()) ? name.trim() : `${name.trim() || 'Scan'}.pdf`;
    onDone(new File([pdf], fileName, { type: 'application/pdf' }));
  };
  return (
    <Modal title="Scan to PDF" onClose={onClose}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Take a photo of each page (or choose pictures); they become one PDF here.</p>
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn" onClick={() => camera.current.click()}><Icon name="image" /> {pages.length ? 'Take another page' : 'Take a photo'}</button>
          <button type="button" className="btn" onClick={() => pictures.current.click()}><Icon name="upload" /> Choose pictures</button>
        </div>
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label="Photo of a page" onChange={(e) => { add([...e.target.files]); e.target.value = ''; }} />
        <input ref={pictures} type="file" accept="image/*" multiple hidden aria-label="Pictures of pages" onChange={(e) => { add([...e.target.files]); e.target.value = ''; }} />
        {pages.length > 0 && (
          <ol className="scan-pages" aria-label="Pages">
            {pages.map((p, i) => (
              <li key={p.url}>
                <img src={p.url} alt={`Page ${i + 1}`} />
                <div className="row" style={{ gap: 2, justifyContent: 'center' }}>
                  <button type="button" className="icon-btn" aria-label={`Move page ${i + 1} earlier`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="left" size={16} /></button>
                  <button type="button" className="icon-btn" aria-label={`Remove page ${i + 1}`} onClick={() => remove(i)}><Icon name="close" size={16} /></button>
                  <button type="button" className="icon-btn" aria-label={`Move page ${i + 1} later`} disabled={i === pages.length - 1} onClick={() => move(i, 1)}><Icon name="right" size={16} /></button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <label className="check"><input type="checkbox" checked={bw} onChange={(e) => { setBw(e.target.checked); if (photos.length) redo(photos, e.target.checked); }} /> Black and white, like a scanner</label>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!pages.length || busy} onClick={save}>{busy ? 'Preparing…' : `Save PDF${pages.length ? ` (${pages.length} page${pages.length === 1 ? '' : 's'})` : ''}`}</button>
        </div>
      </div>
    </Modal>
  );
}
