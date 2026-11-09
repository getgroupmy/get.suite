/** The two ends of an arrow's head at (x1, y1), for a line from (x0, y0): `len` long, 28° either side. */
export function arrowHead(x0, y0, x1, y1, len = 14, spread = (28 * Math.PI) / 180) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  return [[x1 - len * Math.cos(a - spread), y1 - len * Math.sin(a - spread)], [x1 - len * Math.cos(a + spread), y1 - len * Math.sin(a + spread)]];
}

/**
 * Draw one stroke on a 2D canvas context: { kind: pen | erase | line | arrow | box | ellipse, color,
 * size, points: [[x, y], …] } (shapes use the first and last point), scaled by `k` (canvas units per point).
 */
export function drawStroke(g, s, k = 1) {
  const pts = (s.points || []).map(([x, y]) => [x * k, y * k]);
  if (!pts.length) return;
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = s.kind === 'erase' ? '#ffffff' : s.color || '#202124';
  g.lineWidth = (s.kind === 'erase' ? (s.size || 4) * 4 : s.size || 4) * k;
  g.beginPath();
  const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
  if (s.kind === 'pen' || s.kind === 'erase') {
    g.moveTo(x0, y0);
    if (pts.length === 1) g.lineTo(x0 + 0.01, y0 + 0.01);
    for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
  } else if (s.kind === 'line' || s.kind === 'arrow') {
    g.moveTo(x0, y0); g.lineTo(x1, y1);
    if (s.kind === 'arrow') { const [a, b] = arrowHead(x0, y0, x1, y1, Math.max(12, (s.size || 4) * 3) * k); g.moveTo(x1, y1); g.lineTo(...a); g.moveTo(x1, y1); g.lineTo(...b); }
  } else if (s.kind === 'box') g.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  else if (s.kind === 'ellipse') g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  g.stroke();
  g.restore();
}
