// /pub/<token>: a published document, spreadsheet or presentation, read-only, for anyone with the
// address (no account). It checks for a newer version every minute.
import { useEffect, useMemo, useState } from 'react';
import { DocPreview } from './docs/DocEditor.jsx';
import { SlideView } from './slides/SlidesEditor.jsx';
import { themeOf } from './slides/slidemath.js';
import { bookEvaluator, cellKey, colName, display, parseRef } from './sheets/formula.js';
import { formatNumber, cellStyle } from './sheets/cellformat.js';
import { CellPicture } from './sheets/SheetPicture.jsx';
import { heightOf } from './sheets/rowheights.js';
import ChartView from './sheets/Chart.jsx';
import { chartData } from './sheets/charts.js';

export default function PublishedPage({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let first = true;
    const load = () => fetch(`/api/public/pub/${encodeURIComponent(token)}${first ? '' : '?peek=1'}`).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Nothing is published at this address.'); return; }
      first = false;
      setData((cur) => (cur && cur.updated_at === d.updated_at ? cur : d));
      document.title = d.name;
    }).catch(() => setError('The server could not be reached.'));
    load();
    const t = setInterval(load, 60e3);
    return () => clearInterval(t);
  }, [token]);
  const base = `/api/public/pub/${encodeURIComponent(token)}`;
  const embedded = new URLSearchParams(window.location.search).has('embed'); // inside another website: no heading
  return (
    <div className={`pub-page ${embedded ? 'embedded' : ''}`}>
      <header className="pub-head" hidden={embedded}>
        <div className="grow"><h1>{data?.name || 'Published'}</h1>{data && <div className="muted small">Published by {data.org_name} · updated {new Date(data.updated_at).toLocaleString()}</div>}</div>
      </header>
      <main className="pub-main">
        {error ? <p className="error" role="alert">{error}</p> : !data ? <p className="muted">Loading…</p>
          : data.kind === 'doc' ? <DocPreview key={data.updated_at} content={data.content} pictureBase={base} look={data.look} />
          : data.kind === 'slides' ? <PublishedDeck deck={data.content} base={base} />
          : <PublishedSheet book={data.content} base={base} />}
      </main>
    </div>
  );
}

export function PublishedDeck({ deck, base }) {
  const theme = themeOf(deck);
  return (
    <ol className="pub-slides" aria-label="Slides">
      {(deck.slides || []).map((s, i) => <li key={s.id} aria-label={`Slide ${i + 1}`}><SlideView slide={s} theme={theme} deckId={null} pictureBase={base} number={deck.numbers && !(deck.numbers === 'skip-first' && i === 0) ? i + 1 : null} /></li>)}
    </ol>
  );
}

/** Each sheet's cells as a table (values worked out, formatted as in the spreadsheet). */
export function PublishedSheet({ book, base = null }) {
  const [at, setAt] = useState(0);
  const sheet = book.sheets[at] || { cells: {}, formats: {} };
  const view = useMemo(() => {
    const evaluate = bookEvaluator(book.sheets, at, null, book.functions); // other sheets, named ranges and named functions work too
    let maxR = 0, maxC = 0;
    for (const k of Object.keys(sheet.cells || {})) { const p = parseRef(k); if (p) { maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c); } }
    // Pictures over the cells: each in the cell its corner is over, the same distance in (this table's columns are
    // as wide as their text, so the picture stays with its cell rather than at the same spot on the page).
    // Charts too (they need no pictures from the server).
    const pictures = new Map(), charts = new Map();
    const widths = sheet.widths || sheet.colWidths;
    const anchor = (into, p) => {
      let c = 0, ox = Math.max(0, (Number(p.x) || 0) - 46), r = 0, oy = Math.max(0, (Number(p.y) || 0) - 24);
      for (let w; c < 51 && ox >= (w = Number(widths?.[colName(c)]) || 100); c++) ox -= w;
      for (let h; r < 999 && oy >= (h = Number(sheet.rowHeights?.[String(r + 1)]) || 24); r++) oy -= h;
      const k = cellKey(c, r);
      into.set(k, [...(into.get(k) || []), { ...p, ox, oy }]);
      maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
    };
    for (const p of base ? Object.values(sheet.pictures || {}) : []) if (p?.file) anchor(pictures, p); // (a list as published, or by id as kept)
    for (const ch of Object.values(sheet.charts || {})) if (ch?.range && Number.isFinite(Number(ch.x)) && Number.isFinite(Number(ch.y))) anchor(charts, ch);
    maxR = Math.min(maxR, 999); maxC = Math.min(maxC, 51);
    const value = (k) => { let v; try { v = evaluate(k); } catch (e) { v = { error: e.code || '#ERROR!' }; } return formatNumber(v, sheet.formats?.[k]) ?? display(v); };
    const image = (k) => { try { return evaluate.imageOf?.(k) || null; } catch { return null; } };
    const raw = (k) => { try { return evaluate(k); } catch { return null; } };
    return { rows: maxR + 1, cols: maxC + 1, value, image, pictures, charts, raw };
  }, [sheet, book, at, base]);
  return (
    <div className="stack">
      {book.sheets.length > 1 && <div className="tabs" role="tablist" aria-label="Sheets">{book.sheets.map((s, i) => <button key={s.name} type="button" role="tab" aria-selected={i === at} className={i === at ? 'on' : ''} onClick={() => setAt(i)}>{s.name}</button>)}</div>}
      <div className="pub-sheet-wrap">
        <table className="pub-sheet">
          <thead><tr><th />{Array.from({ length: view.cols }, (_, c) => <th key={c} scope="col">{colName(c)}</th>)}</tr></thead>
          <tbody>{Array.from({ length: view.rows }, (_, r) => (
            <tr key={r} style={heightOf(sheet.rowHeights, r) ? { height: heightOf(sheet.rowHeights, r), '--rh': `${heightOf(sheet.rowHeights, r) - 4}px` } : undefined}><th scope="row">{r + 1}</th>{Array.from({ length: view.cols }, (_, c) => { const k = cellKey(c, r), pics = view.pictures.get(k), chs = view.charts.get(k); return <td key={k} data-k={k} className={pics || chs ? 'has-pictures' : undefined} style={cellStyle(sheet.formats?.[k])}>{base && view.image(k) ? <CellPicture image={view.image(k)} base={base} label={`Picture in ${k}`} /> : view.value(k)}{pics?.map((p, i) => <img key={i} className="pub-picture" src={`${base}/pictures/${encodeURIComponent(p.file)}`} alt={p.alt || ''} style={{ left: p.ox, top: p.oy, width: p.w, height: p.h }} />)}{chs?.map((ch, i) => <PublishedChart key={`c${i}`} chart={ch} value={view.raw} />)}</td>; })}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

/** A chart over the cells of a published spreadsheet: its title and the chart, at its size. */
function PublishedChart({ chart, value }) {
  const w = Math.max(160, Number(chart.w) || 480), h = Math.max(120, Number(chart.h) || 300);
  const data = chartData(chart.range, value);
  return (
    <figure className="pub-chart" style={{ left: chart.ox, top: chart.oy, width: w, height: h }} aria-label={`Chart: ${chart.title || 'Untitled'}`}>
      {chart.title && <figcaption>{chart.title}</figcaption>}
      <ChartView type={chart.type} data={data} width={w - 20} height={h - (chart.title ? 44 : 20)} />
    </figure>
  );
}
