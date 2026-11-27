// Checks before saving a data file from the text editor: a .json file that doesn't parse is caught, with where
// (line and column, and the offset to put the cursor at), so it can be fixed or saved anyway. Other kinds: no check.

/** null when fine (or not checked), else { message, line, column, at }. */
export function checkText(name, text) {
  if (!/\.json$/i.test(String(name || '')) || !String(text).trim()) return null;
  try { JSON.parse(text); return null; } catch (e) {
    const msg = String(e.message || 'Not valid JSON');
    // V8 says "… at position 42" or "… (line 3 column 5)"; work out the other from whichever is given.
    let at = /position (\d+)/.exec(msg)?.[1];
    const lc = /line (\d+) column (\d+)/.exec(msg);
    if (at === undefined && lc) {
      const lines = text.split('\n');
      at = lines.slice(0, Number(lc[1]) - 1).reduce((n, l) => n + l.length + 1, 0) + Number(lc[2]) - 1;
    }
    at = at === undefined ? text.length : Math.min(Number(at), text.length);
    const before = text.slice(0, at).split('\n');
    const line = before.length, column = before[before.length - 1].length + 1;
    const what = msg.replace(/\s*(in JSON )?at position \d+.*$/, '').replace(/\s*\(line \d+ column \d+\)$/, '').replace(/^JSON\.parse: /, '');
    return { message: `This isn’t valid JSON (line ${line}, column ${column}): ${what}`, line, column, at };
  }
}
