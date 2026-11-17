/** A running timer in words: "12 min left" for a focus session, else the time so far ("8 min", "1 h 05"). */
export function timerText(run, now = Date.now()) {
  if (run.until) return `${Math.max(0, Math.ceil((run.until - now) / 60e3))} min left`;
  const m = Math.max(0, Math.floor((now - run.since) / 60e3));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
