// A PDF's pages shown one under the other, read-only (pdf.js, loaded with this): the signing page uses it.
import { useEffect, useRef, useState } from 'react';

export default function PdfPages({ url, width = 760 }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let gone = false, doc = null;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
        const list = [];
        for (let i = 1; i <= Math.min(doc.numPages, 300); i++) list.push(await doc.getPage(i));
        if (!gone) setPages(list);
      } catch { if (!gone) setError('This PDF couldn’t be shown'); }
    })();
    return () => { gone = true; doc?.destroy?.(); };
  }, [url]);
  if (error) return <p className="error">{error}</p>;
  if (!pages) return <p className="muted">Opening the PDF…</p>;
  return (
    <div className="pdf-pages" aria-label="The PDF">
      {pages.map((p, i) => <Page key={i} page={p} n={i + 1} width={width} />)}
    </div>
  );
}

function Page({ page, n, width }) {
  const ref = useRef();
  const base = page.getViewport({ scale: 1 });
  const w = Math.min(width, window.innerWidth - 32), h = (base.height / base.width) * w;
  useEffect(() => {
    const c = ref.current, ratio = window.devicePixelRatio || 1;
    const v = page.getViewport({ scale: (w / base.width) * ratio });
    c.width = v.width; c.height = v.height;
    page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise.then(() => { c.dataset.ready = '1'; }).catch(() => {});
  }, [page, w, base.width]);
  return <canvas ref={ref} className="pdf-pages-page" style={{ width: w, height: h }} aria-label={`Page ${n}`} />;
}
