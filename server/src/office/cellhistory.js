// A cell's edit history in a spreadsheet, from its saved versions: each change with what it became,
// what it was before, who made it and when. Versions are kept per editing session, so a change shows
// once per session (the last value that person left), the way a spreadsheet's version history does.

const valueOf = (content, index, name, cell) => {
  const sheets = content?.sheets || [];
  const s = sheets.find((x) => x?.name === name) ?? sheets[index];
  const v = s?.cells?.[cell];
  return v === undefined || v === null ? '' : String(v);
};

/**
 * states: the spreadsheet as it is now and as saved before, newest first: [{ content, by, at }].
 * Returns the changes to `cell` on the sheet at `index` (or named `name`), newest first: [{ value, before, by, at }].
 */
export function cellHistory(states, { index = 0, name = null, cell }, max = 50) {
  const out = [];
  for (let i = 0; i < states.length && out.length < max; i++) {
    const now = valueOf(states[i].content, index, name, cell);
    const older = states[i + 1];
    const before = older ? valueOf(older.content, index, name, cell) : '';
    if (now !== before) out.push({ value: now, before, by: states[i].by || null, at: states[i].at });
  }
  return out;
}
