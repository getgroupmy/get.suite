// What others answered, for people who've answered a form that shares it: how the choices, scales,
// ratings, grids and rankings went, as counts (never who said what, nor anything typed).
import { useEffect, useState } from 'react';
import { percent } from './formmath.js';

/** The key a response sent from this browser was given, to see the summary again later (forms for anyone). */
export const resultsKey = {
  get: (token) => { try { return localStorage.getItem(`form-results:${token}`) || ''; } catch { return ''; } },
  set: (token, key) => { try { localStorage.setItem(`form-results:${token}`, key); } catch { /* private window */ } },
};

export default function FormResults({ token, k, onClose }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/public/forms/${encodeURIComponent(token)}/results${k ? `?key=${encodeURIComponent(k)}` : ''}`, { headers: { 'x-requested-with': 'nas-workspace' } })
      .then(async (res) => { const d = await res.json().catch(() => null); if (!res.ok) throw new Error(d?.error || 'The answers couldn’t be loaded'); setR(d); })
      .catch((e) => setError(e.message));
  }, [token, k]);
  if (error) return <p className="error small" role="alert">{error}</p>;
  if (!r) return <p className="muted">Loading what others answered…</p>;
  return (
    <section className="stack form-results" aria-label="What others answered">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>What others answered</h2>
        {onClose && <button type="button" className="link-btn small" onClick={onClose}>Hide</button>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>{r.responses === 1 ? '1 response' : `${r.responses} responses`} so far. Who answered, and what anyone wrote, stays private.</p>
      {r.questions.map((s) => (
        <section key={s.id} className="card form-summary" aria-label={`Results: ${s.title}`}>
          <h3>{s.title}</h3>
          <p className="muted small">{s.answered === 1 ? '1 answer' : `${s.answered} answers`}{s.average != null ? ` · average ${s.average}` : ''}</p>
          {s.grid ? (
            <div className="form-grid-wrap"><table className="form-grid form-grid-sum">
              <thead><tr><th />{(s.grid[0]?.bars || []).map((b) => <th key={b.label} scope="col">{b.label}</th>)}</tr></thead>
              <tbody>{s.grid.map((g) => <tr key={g.row}><th scope="row">{g.row}</th>{g.bars.map((b) => <td key={b.label} aria-label={`${g.row}, ${b.label}: ${b.count}`}><span className="form-grid-count" style={{ '--share': b.share }}>{b.count}</span></td>)}</tr>)}</tbody>
            </table></div>
          ) : s.bars ? (
            <ul className="form-bars">
              {s.bars.map((b) => (
                <li key={b.label}><span className="form-bar-label">{b.label}</span>
                  <span className="form-bar"><span style={{ width: percent(b.share) }} /></span>
                  <span className="small nowrap">{b.count} ({percent(b.share)})</span></li>
              ))}
            </ul>
          ) : s.ranks ? (
            <ol className="form-rank-sum" aria-label="Average places">
              {s.ranks.map((x) => <li key={x.label}><span className="grow">{x.label}</span><span className="small nowrap">{x.average == null ? 'not ranked' : `average place ${x.average}`}{x.first ? ` · first for ${x.first}` : ''}</span></li>)}
            </ol>
          ) : null}
        </section>
      ))}
    </section>
  );
}
