// How long ago someone last used their account, for the Users list.
export const INACTIVE_DAYS = 90;
export const inactive = (u, now = Date.now()) => !u.disabled && (!u.last_active || now - u.last_active >= INACTIVE_DAYS * 864e5);
/** "Today", "Yesterday", "12 days ago", "3 months ago", "Never". */
export function lastActiveText(t, now = Date.now()) {
  if (!t) return 'Never';
  const days = Math.floor((now - t) / 864e5);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 60) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months} months ago` : `${Math.floor(days / 365)} years ago`;
}

