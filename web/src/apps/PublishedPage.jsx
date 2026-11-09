// /pub/<token>: a published document, spreadsheet or presentation, read-only, for anyone with the
// address (no account). It checks for a newer version every minute.
import { useEffect, useMemo, useState } from 'react';
import { DocPreview } from './docs/DocEditor.jsx';
import { SlideView } from './slides/SlidesEditor.jsx';
import { THEMES } from './slides/slidemath.js';
import { bookEvaluator, cellKey, colName, display, parseRef } from './sheets/formula.js';
import { formatNumber, cellStyle } from './sheets/cellformat.js';
import { CellPicture } from './sheets/SheetPicture.jsx';

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
          : data.kind === 'doc' ? <DocPreview key={data.updated_at} content={data.content} pictureBase={base} />
          : data.kind === 'slides' ? <PublishedDeck deck={data.content} base={base} />
          : <PublishedSheet book={data.content} base={base} />}
      </main>
    </div>
  );
}

export function PublishedDeck({ deck, base }) {
  const theme = THEMES[deck.theme] || THEMES.light;
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
    maxR = Math.min(maxR, 999); maxC = Math.min(maxC, 51);
    const value = (k) => { let v; try { v = evaluate(k); } catch (e) { v = { error: e.code || '#ERROR!' }; } return formatNumber(v, sheet.formats?.[k]) ?? display(v); };
    const image = (k) => { try { return evaluate.imageOf?.(k) || null; } catch { return null; } };
    return { rows: maxR + 1, cols: maxC + 1, value, image };
  }, [sheet, book, at]);
  return (
    <div className="stack">
      {book.sheets.length > 1 && <div className="tabs" role="tablist" aria-label="Sheets">{book.sheets.map((s, i) => <button key={s.name} type="button" role="tab" aria-selected={i === at} className={i === at ? 'on' : ''} onClick={() => setAt(i)}>{s.name}</button>)}</div>}
      <div className="pub-sheet-wrap">
        <table className="pub-sheet">
          <thead><tr><th />{Array.from({ length: view.cols }, (_, c) => <th key={c} scope="col">{colName(c)}</th>)}</tr></thead>
          <tbody>{Array.from({ length: view.rows }, (_, r) => (
            <tr key={r}><th scope="row">{r + 1}</th>{Array.from({ length: view.cols }, (_, c) => { const k = cellKey(c, r); return <td key={k} data-k={k} style={cellStyle(sheet.formats?.[k])}>{base && view.image(k) ? <CellPicture image={view.image(k)} base={base} label={`Picture in ${k}`} /> : view.value(k)}</td>; })}</tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
