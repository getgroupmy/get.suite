// Time off: the words for someone's vacation balance.

/** "7 of 25 vacation days left in 2026 (3 waiting for an answer)", or null when there's no limit. */
export function balanceText(b) {
  if (!b || b.days === null || b.days === undefined) return null;
  const extra = [b.carried ? `${b.carried} carried over from ${b.year - 1}` : null, b.pending ? `${b.pending} waiting for an answer` : null].filter(Boolean);
  return `${Math.max(0, b.left)} of ${b.days} vacation day${b.days === 1 ? '' : 's'} left in ${b.year}${extra.length ? ` (${extra.join('; ')})` : ''}`;
}


/** "3 working days", "1 working day", "half a working day". */
export const daysText = (n) => (n === 0.5 ? 'half a working day' : `${n} working day${n === 1 ? '' : 's'}`);
export const HALVES = { am: 'morning', pm: 'afternoon' };
