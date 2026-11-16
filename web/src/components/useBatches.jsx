import { useEffect, useRef, useState } from 'react';

/**
 * A long list put on the page a batch at a time (thousands at once take seconds to draw): `step` items
 * first, then another batch whenever the end of what's shown comes near the screen, or with the button.
 * `reset` (a string) starts again from the first batch, e.g. when the folder, search or sort changes.
 * Returns { shown, more (an element to put after the list, or null), all () (show them all now) }.
 */
export function useBatches(items, step = 200, reset = '') {
  const [limit, setLimit] = useState(step);
  useEffect(() => { setLimit(step); }, [reset, step]);
  const shown = items.length > limit ? items.slice(0, limit) : items;
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((seen) => { if (seen.some((x) => x.isIntersecting)) setLimit((n) => n + step); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length, items.length, step]);
  const left = items.length - shown.length;
  const more = left > 0 ? (
    <div ref={ref} className="more-files"><button type="button" className="btn small" onClick={() => setLimit((n) => n + step)}>Show {Math.min(step, left)} more of {left}</button></div>
  ) : null;
  return { shown, more, all: () => setLimit(items.length) };
}
