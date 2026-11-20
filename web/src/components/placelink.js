// Links to a place inside a file: a slide (/slides/<id>#slide=<slide id>), a sheet (/sheets/<id>#sheet=<its name>),
// or cells on it (#sheet=<name>&range=B2:C4).

/** The key=value parts of a location hash (#a=1&b=2), decoded; a part that can't be decoded is left out. */
export function placeParams(hash) {
  const out = {};
  for (const part of String(hash || '').replace(/^#/, '').split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1)); } catch { /* left out */ }
  }
  return out;
}

/** The value of `key` in a location hash (decoded), or null. */
export const placeInHash = (hash, key) => placeParams(hash)[key] || null;

/** A link to that place: the file's address with #key=value (and more: { key: value }). */
export const placeLink = (origin, path, key, value, more = {}) => `${origin}${path}#${[[key, value], ...Object.entries(more)].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
