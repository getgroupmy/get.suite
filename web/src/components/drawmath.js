/** The two ends of an arrow's head at (x1, y1), for a line from (x0, y0): `len` long, 28° either side. */
export function arrowHead(x0, y0, x1, y1, len = 14, spread = (28 * Math.PI) / 180) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  return [[x1 - len * Math.cos(a - spread), y1 - len * Math.sin(a - spread)], [x1 - len * Math.cos(a + spread), y1 - len * Math.sin(a + spread)]];
}
