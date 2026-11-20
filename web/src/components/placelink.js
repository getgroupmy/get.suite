// Links to a place inside a file: a slide (/slides/<id>#slide=<slide id>) or a sheet (/sheets/<id>#sheet=<its name>).

/** The value of `#key=value` in a location hash (decoded), or null. */
export function placeInHash(hash, key) {
  const m = new RegExp(`^#${key}=(.+)$`).exec(String(hash || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/** A link to that place: the file's address with #key=value. */
export const placeLink = (origin, path, key, value) => `${origin}${path}#${key}=${encodeURIComponent(value)}`;
