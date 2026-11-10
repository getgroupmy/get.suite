// Audience Q&A while presenting (server: routes/slideqa.js). QaPanel is what the presenter sees (on the
// presenting screen and in Presenter view): the link to ask at, and the questions, most upvoted first, with
// Mark answered. QaPage is /qa/<code>, where people at the company ask and upvote.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { get, post, del } from '../../api.js';
import { useToast } from '../../components/ui.jsx';

/** The session, asked for again every few seconds (and right after anything you do). */
function useQa(code, every = 3000) {
  const [qa, setQa] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => (code ? get(`/slide-qa/${code}`).then((v) => { setQa(v); setError(''); }).catch((e) => setError(e.message)) : null), [code]);
  useEffect(() => {
    if (!code) return undefined;
    load();
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [code, every, load]);
  return { qa, setQa, error };
}

export const qaLink = (code) => `${window.location.host}/qa/${code}`;

export function QaPanel({ code, onHide, onEnded }) {
  const toast = useToast();
  const { qa, setQa } = useQa(code);
  const act = async (fn) => { try { setQa(await fn()); } catch (e) { toast(e.message, 'error'); } };
  if (!qa) return null;
  const open = qa.questions.filter((x) => !x.answered);
  return (
    <aside className="qa-panel" aria-label="Audience questions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="qa-panel-head">
        <span className="grow">Ask at <strong className="qa-link">{qaLink(code)}</strong></span>
        {onHide && <button type="button" className="qa-x" aria-label="Hide questions" onClick={onHide}>✕</button>}
      </div>
      {!qa.open && <p className="qa-muted">The Q&A has ended.</p>}
      {qa.questions.length === 0 && qa.open && <p className="qa-muted">No questions yet.</p>}
      <ol className="qa-list">
        {qa.questions.map((x) => (
          <li key={x.id} className={x.answered ? 'answered' : ''}>
            <span className="qa-votes" aria-label={`${x.votes} upvotes`}>▲ {x.votes}</span>
            <span className="grow"><span className="qa-body">{x.body}</span><span className="qa-who">{x.who || 'Anonymous'}</span></span>
            {qa.runs && <button type="button" className="qa-btn" onClick={() => act(() => post(`/slide-qa/questions/${x.id}/answered`, { answered: !x.answered }))}>{x.answered ? 'Not answered' : 'Mark answered'}</button>}
          </li>
        ))}
      </ol>
      {qa.runs && qa.open && <div className="qa-panel-foot"><span className="qa-muted">{open.length} open</span>
        <button type="button" className="qa-btn" onClick={() => act(async () => { const v = await post(`/slide-qa/${code}/end`); onEnded?.(); return v; })}>End Q&A</button></div>}
    </aside>
  );
}

/** /qa/<code>: ask a question about the presentation being given, and upvote the ones you want answered. */
export function QaPage() {
  const { code } = useParams();
  const toast = useToast();
  const { qa, setQa, error } = useQa(code);
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const act = async (fn) => { try { setQa(await fn()); return true; } catch (e) { toast(e.message, 'error'); return false; } };
  useEffect(() => { document.title = qa ? `Q&A · ${qa.title}` : 'Q&A'; }, [qa]);
  if (error && !qa) return <main className="qa-page"><div className="card stack"><h1>Q&A</h1><p>{error}</p></div></main>;
  if (!qa) return <main className="qa-page"><p className="muted">Loading…</p></main>;
  return (
    <main className="qa-page">
      <div className="card stack">
        <div><h1 style={{ margin: 0 }}>{qa.title}</h1><p className="muted small" style={{ margin: 0 }}>Questions for {qa.presenter || 'the presenter'}{qa.open ? '' : ' · this Q&A has ended'}</p></div>
        {qa.open && (
          <form className="stack" onSubmit={async (e) => { e.preventDefault(); if (await act(() => post(`/slide-qa/${code}/questions`, { body: text, anonymous }))) setText(''); }}>
            <label className="field"><span>Your question</span><textarea rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} required /></label>
            <div className="row"><label className="row small grow"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> Ask without my name</label>
              <button className="btn primary" disabled={!text.trim()}>Ask</button></div>
          </form>
        )}
      </div>
      <ol className="qa-list page" aria-label="Questions">
        {qa.questions.length === 0 && <li className="muted">No questions yet: be the first.</li>}
        {qa.questions.map((x) => (
          <li key={x.id} className={`card ${x.answered ? 'answered' : ''}`}>
            <button type="button" className={`qa-up ${x.voted ? 'on' : ''}`} aria-pressed={x.voted} disabled={x.mine || !qa.open} aria-label={x.voted ? `Take back upvote (${x.votes})` : `Upvote (${x.votes})`}
              title={x.mine ? 'Your question' : 'Upvote: you want this answered'} onClick={() => act(() => post(`/slide-qa/questions/${x.id}/vote`, { on: !x.voted }))}>▲ {x.votes}</button>
            <span className="grow"><span className="qa-body">{x.body}</span><span className="qa-who muted small">{x.who || 'Anonymous'}{x.mine ? ' (you)' : ''}{x.answered ? ' · ✓ Answered' : ''}</span></span>
            {x.mine && qa.open && <button type="button" className="link-btn small" onClick={() => act(() => del(`/slide-qa/questions/${x.id}`))}>Delete</button>}
          </li>
        ))}
      </ol>
    </main>
  );
}
