// The speaker's window while presenting: this slide, the next one, the speaker notes and a timer.
// It follows the presentation in the other window (and can move it) over a BroadcastChannel; the
// slides come from that window, so nothing is loaded twice.
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { SlideView } from './SlidesEditor.jsx';
import { QaPanel } from './SlideQa.jsx';
import { get } from '../../api.js';
import { themeOf, stepSlide, numberShown } from './slidemath.js';

const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function PresenterView() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [deck, setDeck] = useState(null);
  const [i, setI] = useState(Number(params.get('slide')) || 0);
  const [build, setBuild] = useState({ b: null, of: 0 }); // animated boxes in on the audience's screen
  const [ended, setEnded] = useState(false);
  const [started] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const ch = useRef(null);

  useEffect(() => {
    document.title = 'Presenter view';
    const c = new BroadcastChannel(`nw-present-${id}`);
    ch.current = c;
    c.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'deck') { setDeck(m.deck); if (Number.isInteger(m.i)) setI(m.i); setEnded(false); }
      if (m.type === 'at') { setI(m.i); setBuild({ b: m.b ?? null, of: m.of || 0 }); }
      if (m.type === 'end') setEnded(true);
    };
    c.postMessage({ type: 'hello' });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); c.close(); };
  }, [id]);

  // Audience Q&A running for this presentation (started from the presenting screen): its questions here too.
  const [qaCode, setQaCode] = useState(null);
  useEffect(() => {
    const look = () => get(`/slide-qa/decks/${id}`).then((s) => setQaCode(s?.code || null)).catch(() => {});
    look();
    const t = setInterval(look, 5000);
    return () => clearInterval(t);
  }, [id]);
  const last = (deck?.slides.length || 1) - 1;
  const go = (n) => { const to = Math.max(0, Math.min(last, n)); setI(to); ch.current?.postMessage({ type: 'go', i: to }); };
  useEffect(() => {
    const onKey = (e) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); if (deck) go(stepSlide(deck, i, 1)); }
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); if (deck) go(stepSlide(deck, i, -1)); }
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(last);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (ended) return <div className="presenter-view ended"><p>The presentation has ended.</p><button type="button" className="btn" onClick={() => window.close()}>Close this window</button></div>;
  if (!deck) return <div className="presenter-view ended"><p className="muted">Waiting for the presentation… Start it from the presentation’s window.</p></div>;
  const theme = themeOf(deck);
  const slide = deck.slides[i], next = stepSlide(deck, i, 1) !== i ? deck.slides[stepSlide(deck, i, 1)] : null; // skipped slides aren't next
  return (
    <div className="presenter-view">
      <header className="row">
        <strong className="grow">Slide {i + 1} of {deck.slides.length}</strong>
        <span className="pv-timer" title="Time since you started" aria-label={`Time since you started: ${clock(now - started)}`}>{clock(now - started)}</span>
        <span className="muted">{new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      </header>
      <div className="pv-main">
        <section className="pv-current" aria-label="Current slide">{slide && <SlideView slide={slide} theme={theme} deckId={id} built={build.of ? build.b ?? undefined : undefined} number={numberShown(deck, i) ? i + 1 : null} />}
          {build.of > 0 && <span className="muted small pv-builds">Animations: {build.b} of {build.of} in{build.b < build.of ? ' · click for the next' : ''}</span>}</section>
        <aside className="pv-side">
          <section className="pv-next" aria-label="Next slide">
            <span className="muted small">Next</span>
            {next ? <SlideView slide={next} theme={theme} deckId={id} /> : <div className="pv-end muted">End of presentation</div>}
          </section>
          <section className="pv-notes" aria-label="Speaker notes">{slide?.notes || <span className="muted">No notes for this slide</span>}</section>
          {qaCode && <QaPanel key={qaCode} code={qaCode} onEnded={() => setQaCode(null)} />}
        </aside>
      </div>
      <footer className="row">
        <button type="button" className="btn" disabled={stepSlide(deck, i, -1) === i} onClick={() => go(stepSlide(deck, i, -1))}>‹ Previous</button>
        <button type="button" className="btn primary" disabled={stepSlide(deck, i, 1) === i} onClick={() => go(stepSlide(deck, i, 1))}>Next ›</button>
      </footer>
    </div>
  );
}
