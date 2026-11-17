/** A writing sprint's corner text: words added so far and the time left ("+120 words · 12:05"). */
export function sprintText(msLeft, added) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  const words = `${added >= 0 ? '+' : '−'}${Math.abs(added)} ${Math.abs(added) === 1 ? 'word' : 'words'}`;
  return `${words} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export const SPRINTS = [10, 25, 45]; // minutes
