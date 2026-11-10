// Column letters and sheet names in formulas, as the web app's formula.js writes them (for tablerefs.js).
export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export const sheetPrefix = (name) => (/^[A-Z_][A-Z0-9_]*$/i.test(name) && !/^[A-Z]{1,3}\d+$/i.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);
