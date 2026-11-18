// pdf-lib measures standard-font text with kerning, but draws it without: words laid out by those measurements end
// up a little too close (after "y," a space all but vanishes). Measure as drawn: each character's own width.
export function asDrawn(font) {
  const one = font.widthOfTextAtSize.bind(font);
  const cache = new Map();
  font.widthOfTextAtSize = (text, size) => {
    let w = 0;
    for (const ch of String(text)) { let u = cache.get(ch); if (u === undefined) { u = one(ch, 1000) / 1000; cache.set(ch, u); } w += u; }
    return w * size;
  };
  return font;
}
