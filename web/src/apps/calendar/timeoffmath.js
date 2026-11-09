// Time off: the words for someone's vacation balance.

/** "7 of 25 vacation days left in 2026 (3 waiting for an answer)", or null when there's no limit. */
export function balanceText(b) {
  if (!b || b.days === null || b.days === undefined) return null;
  return `${Math.max(0, b.left)} of ${b.days} vacation day${b.days === 1 ? '' : 's'} left in ${b.year}${b.pending ? ` (${b.pending} waiting for an answer)` : ''}`;
}

