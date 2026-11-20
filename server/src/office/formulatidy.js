// Formulas read from a file another program saved: function names in capitals (LibreOffice writes the ones it doesn't
// know in small letters: =xlookup(…), =let(…)) and references to the book's sheets spelled as the sheets are named
// (other!A:A for a sheet called Other). Both work either way; this keeps them looking as they were written.

/** Tidy one formula ("=…") for a book whose sheets are `sheetNames`. */
export function tidyFormula(f, sheetNames = []) {
  if (typeof f !== 'string' || !f.startsWith('=')) return f;
  const byUpper = new Map(sheetNames.map((n) => [String(n).toUpperCase(), String(n)]));
  const quote = (n) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && !/^[A-Za-z]{1,3}\d+$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
  return f.replace(/("(?:[^"]|"")*")|'((?:[^']|'')+)'!|(?<![A-Za-z0-9_.'])([A-Za-z_][A-Za-z0-9_.]*)!|(?<![A-Za-z0-9_.$])([A-Za-z_][A-Za-z0-9_.]*)(?=\()/g,
    (m, str, quoted, bare, fn) => {
      if (str) return str;
      if (quoted !== undefined || bare !== undefined) {
        const name = quoted !== undefined ? quoted.replace(/''/g, "'") : bare;
        const real = byUpper.get(name.toUpperCase());
        return real && real !== name ? `${quote(real)}!` : m;
      }
      return fn.toUpperCase();
    });
}

/** Tidy every formula of a book read from a file (in place); returns the book. */
export function tidyBook(book) {
  const names = (book.sheets || []).map((s) => s.name);
  for (const s of book.sheets || []) for (const [k, v] of Object.entries(s.cells || {})) if (typeof v === 'string' && v.startsWith('=')) s.cells[k] = tidyFormula(v, names);
  return book;
}
