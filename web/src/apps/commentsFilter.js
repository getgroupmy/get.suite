// Which comment threads are "for you": you're @mentioned in one of its comments (not by yourself), or it's assigned to you.
const MENTION = /@([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;

export function forYou(threads, me) {
  if (!me) return [];
  const email = (me.username || '').toLowerCase();
  return threads.filter((t) => t.assignee_id === me.id
    || [t, ...(t.replies || [])].some((c) => c.author_id !== me.id && [...(c.body || '').matchAll(MENTION)].some((m) => m[1].toLowerCase() === email)));
}

/** The address of a comment, to paste in Chat or an email: a file's own page, or its preview in Drive. */
export function commentLink(origin, pathname, fileId, commentId) {
  const at = pathname.startsWith('/drive') ? `/drive?preview=${fileId}&comment=${commentId}` : `${pathname}?comment=${commentId}`;
  return origin + at;
}
