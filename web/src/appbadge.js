// The number on the installed app's icon (phones, and installed on a computer): unread mail plus
// unread notifications, the way mail apps show theirs. Where the browser can't, nothing happens.
const parts = { mail: 0, bell: 0 };
export function setBadgePart(kind, n) {
  parts[kind] = Math.max(0, Number(n) || 0);
  const total = parts.mail + parts.bell;
  try {
    if (total && navigator.setAppBadge) navigator.setAppBadge(total).catch(() => {});
    else if (!total && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  } catch { /* not supported */ }
  return total;
}
