// Spotting a QR code in a picture, without reading it: QR codes have three "finder" squares in their
// corners (dark, light, a 3-wide dark centre, light, dark: 1:1:3:1:1 across and down). Finding three that
// are about the same size and sit at the corners of a right angle is enough to say "this is a QR code".
// Used to warn about QR codes in email (scanning one sends a phone to an address nobody checked).

/** Grey levels (0–255, one per pixel) from RGBA data, transparent counting as white. */
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    const a = rgba[i + 3] / 255;
    g[p] = Math.round((0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a));
  }
  return g;
}

/** Dark (true) or light for each pixel, by Otsu's threshold over the picture. */
function binarize(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  const dark = new Uint8Array(total);
  for (let p = 0; p < total; p++) dark[p] = gray[p] <= t ? 1 : 0;
  return dark;
}

/** Whether five runs (dark, light, dark, light, dark) are in the proportions 1:1:3:1:1. */
function finderRatio(r) {
  const total = r[0] + r[1] + r[2] + r[3] + r[4];
  if (total < 7) return false;
  const m = total / 7, tol = m * 0.5;
  return Math.abs(r[0] - m) < tol && Math.abs(r[1] - m) < tol && Math.abs(r[2] - 3 * m) < 3 * tol && Math.abs(r[3] - m) < tol && Math.abs(r[4] - m) < tol;
}

/** The same 1:1:3:1:1 pattern down column x through (x, y)? → its centre y and size, or null. */
function checkVertical(dark, w, h, x, y, size) {
  if (!dark[y * w + x]) return null;
  const run = [0, 0, 0, 0, 0];
  let i = y;
  while (i >= 0 && dark[i * w + x]) { run[2]++; i--; }
  while (i >= 0 && !dark[i * w + x]) { run[1]++; i--; }
  while (i >= 0 && dark[i * w + x]) { run[0]++; i--; }
  let j = y + 1;
  while (j < h && dark[j * w + x]) { run[2]++; j++; }
  while (j < h && !dark[j * w + x]) { run[3]++; j++; }
  while (j < h && dark[j * w + x]) { run[4]++; j++; }
  const total = run.reduce((a, b) => a + b, 0);
  if (!finderRatio(run) || Math.abs(total - size) > size * 0.5) return null;
  return { y: j - run[4] - run[3] - run[2] / 2, size: total };
}

/** Centres of finder squares: [{ x, y, size, n }] (n: how many rows crossed it). */
export function finderPatterns(dark, w, h) {
  const found = [];
  const step = Math.max(1, Math.floor(h / 600)); // big pictures: every few rows is enough
  for (let y = 0; y < h; y += step) {
    // The row as runs of the same colour: [dark?, start, length].
    const runs = [];
    for (let x = 0; x < w; x++) {
      const d = dark[y * w + x];
      if (runs.length && runs[runs.length - 1][0] === d) runs[runs.length - 1][2]++;
      else runs.push([d, x, 1]);
    }
    for (let i = 0; i + 4 < runs.length; i++) {
      if (!runs[i][0]) continue;
      const r = [runs[i][2], runs[i + 1][2], runs[i + 2][2], runs[i + 3][2], runs[i + 4][2]];
      if (!finderRatio(r)) continue;
      const total = r.reduce((a, b) => a + b, 0);
      const cx = Math.round(runs[i + 2][1] + runs[i + 2][2] / 2 - 0.5);
      const v = checkVertical(dark, w, h, cx, y, total);
      if (!v) continue;
      const near = found.find((f) => Math.abs(f.x - cx) < f.size / 2 && Math.abs(f.y - v.y) < f.size / 2);
      if (near) { near.n++; near.x += (cx - near.x) / near.n; near.y += (v.y - near.y) / near.n; }
      else found.push({ x: cx, y: v.y, size: (total + v.size) / 2, n: 1 });
    }
  }
  return found;
}

/** Three finders of about the same size at the corners of a right angle (any turn): a QR code. */
export function looksLikeQr(finders) {
  const f = finders.filter((p) => p.n >= 2);
  for (let a = 0; a < f.length; a++) for (let b = a + 1; b < f.length; b++) for (let c = b + 1; c < f.length; c++) {
    const pts = [f[a], f[b], f[c]];
    const sizes = pts.map((p) => p.size);
    if (Math.max(...sizes) > Math.min(...sizes) * 1.6) continue;
    const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const sides = [d(pts[0], pts[1]), d(pts[1], pts[2]), d(pts[0], pts[2])].sort((x, y) => x - y);
    const [s1, s2, hyp] = sides;
    if (s1 < 2 * sizes[0]) continue; // too close together to be corners of a code
    if (s2 > s1 * 1.25) continue; // the two sides of the corner are equal
    if (Math.abs(hyp - Math.hypot(s1, s2)) > hyp * 0.12) continue; // and at a right angle
    return true;
  }
  return false;
}

/** Whether a picture (grey levels, w × h) shows a QR code. */
export function hasQrCode(gray, w, h) {
  if (w < 21 || h < 21) return false;
  return looksLikeQr(finderPatterns(binarize(gray), w, h));
}
