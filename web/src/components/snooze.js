// When a notification can be snoozed until (the bell's Snooze).
/** Times to snooze until: later today (in 3 hours, while that's still today), tomorrow at 9, next Monday at 9. */
export function snoozeTimes(now = new Date()) {
  const at9 = (d) => { const x = new Date(d); x.setHours(9, 0, 0, 0); return x; };
  const later = new Date(now.getTime() + 3 * 3600e3);
  const tomorrow = at9(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const monday = at9(new Date(now.getFullYear(), now.getMonth(), now.getDate() + (((8 - now.getDay()) % 7) || 7)));
  const hm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return [
    ...(later.getDate() === now.getDate() ? [{ label: 'Later today', when: hm(later), at: later.getTime() }] : []),
    { label: 'Tomorrow', when: `${tomorrow.toLocaleDateString([], { weekday: 'short' })} ${hm(tomorrow)}`, at: tomorrow.getTime() },
    { label: 'Next week', when: `${monday.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${hm(monday)}`, at: monday.getTime() },
  ];
}
