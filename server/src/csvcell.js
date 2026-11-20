// server/src/csvcell.js and web/src/csvcell.js are the same file: keep them so (server/test/csvwrite.test.js checks).
// One field of a CSV file, written so spreadsheets and Python's csv module read back exactly what was there
// (test/csvwrite.test.js checks): quoted when it holds the separator, a quote, a line break (\n or \r) or starts or ends
// with a space. Text of other people's making (names, answers, log lines) is kept from running as a formula when the
// file is opened in Excel or LibreOffice (CSV injection, OWASP): one that starts with =, @, a tab or a line break, or
// with + or - and then more than a number or phone number, gets a ' in front. -5, +3.2, +60 12-345 6789 stay as they are.

/** Would a spreadsheet take this as a formula (or a command)? */
// (+ or - with only digits, spaces and ().,- after it can't call anything: -5, +3.2, a phone number +60 12-345 6789)
export const looksLikeFormula = (s) => /^[=@\t\r\n]/.test(s) || (/^[+-]/.test(s) && /[^\d\s().,+-]/.test(s) && !/^[+-]?(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(s.trim()));

/** One CSV field. { sep }: the separator (',' or ';'); { guard }: false for values that are meant as they are. */
export function csvCell(v, { sep = ',', guard = true } = {}) {
  let s = String(v ?? '');
  if (guard && looksLikeFormula(s)) s = `'${s}`;
  return s.includes(sep) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of values as CSV text (CRLF line ends, as RFC 4180 and Excel have them). */
// (a row of one empty field is written "": an empty line reads as no row at all)
export const csvText = (rows, opts) => rows.map((r) => (r.length === 1 && String(r[0] ?? '') === '' ? '""' : r.map((v) => csvCell(v, opts)).join(opts?.sep || ','))).join('\r\n') + '\r\n';
