// What each formula function takes and does, for the suggestions shown while typing a formula.
// [arguments, description]; optional arguments are in brackets.
export const HELP = {
  // maths
  SUM: ['value1, [value2, …]', 'Adds numbers and ranges'],
  AVERAGE: ['value1, [value2, …]', 'The mean of the numbers'],
  MIN: ['value1, [value2, …]', 'The smallest number'],
  MAX: ['value1, [value2, …]', 'The largest number'],
  MEDIAN: ['value1, [value2, …]', 'The middle number'],
  COUNT: ['value1, [value2, …]', 'How many cells hold numbers'],
  COUNTA: ['value1, [value2, …]', 'How many cells are not empty'],
  COUNTBLANK: ['range', 'How many cells are empty'],
  PRODUCT: ['value1, [value2, …]', 'Multiplies the numbers together'],
  SUMPRODUCT: ['range1, [range2, …]', 'Multiplies matching cells of the ranges and adds the results'],
  LARGE: ['range, k', 'The k-th largest number'],
  SMALL: ['range, k', 'The k-th smallest number'],
  RANK: ['value, range, [ascending]', 'The position of a number in a list (largest first unless ascending is 1)'],
  'RANK.EQ': ['value, range, [ascending]', 'The same as RANK'],
  STDEV: ['value1, [value2, …]', 'Standard deviation of a sample'],
  'STDEV.S': ['value1, [value2, …]', 'Standard deviation of a sample'],
  'STDEV.P': ['value1, [value2, …]', 'Standard deviation of a whole population'],
  STDEVP: ['value1, [value2, …]', 'Standard deviation of a whole population'],
  VAR: ['value1, [value2, …]', 'Variance of a sample'],
  'VAR.S': ['value1, [value2, …]', 'Variance of a sample'],
  'VAR.P': ['value1, [value2, …]', 'Variance of a whole population'],
  VARP: ['value1, [value2, …]', 'Variance of a whole population'],
  ROUND: ['value, [places]', 'Rounds to a number of decimal places'],
  ROUNDUP: ['value, [places]', 'Rounds away from zero'],
  ROUNDDOWN: ['value, [places]', 'Rounds towards zero'],
  TRUNC: ['value, [places]', 'Cuts off decimals without rounding'],
  INT: ['value', 'Rounds down to a whole number'],
  CEILING: ['value, [step]', 'Rounds up to a multiple of step'],
  FLOOR: ['value, [step]', 'Rounds down to a multiple of step'],
  ABS: ['value', 'The number without its sign'],
  SIGN: ['value', '1, 0 or -1 depending on the sign'],
  SQRT: ['value', 'Square root'],
  POWER: ['base, exponent', 'A number raised to a power'],
  MOD: ['value, divisor', 'The remainder after dividing'],
  EXP: ['value', 'e raised to a power'],
  LN: ['value', 'Natural logarithm'],
  LOG: ['value, [base]', 'Logarithm (base 10 unless given)'],
  LOG10: ['value', 'Base-10 logarithm'],
  ISODD: ['value', 'TRUE if the number is odd'],
  ISEVEN: ['value', 'TRUE if the number is even'],
  PI: ['', 'The number π'],
  RAND: ['', 'A random number from 0 to 1'],
  RANDBETWEEN: ['low, high', 'A random whole number between two numbers'],
  // loans
  PMT: ['rate, periods, present_value, [future_value], [type]', 'The payment each period for a loan'],
  PV: ['rate, periods, payment, [future_value], [type]', 'What a series of payments is worth now'],
  FV: ['rate, periods, payment, [present_value], [type]', 'What savings grow to'],
  // conditions
  IF: ['condition, if_true, [if_false]', 'One value when the condition holds, another when it does not'],
  IFS: ['condition1, value1, [condition2, value2, …]', 'The value of the first condition that holds'],
  SWITCH: ['value, case1, result1, […], [default]', 'The result for the first case that matches'],
  IFERROR: ['value, if_error', 'A fallback when the value is an error'],
  IFNA: ['value, if_na', 'A fallback when the value is #N/A'],
  AND: ['test1, [test2, …]', 'TRUE if every test holds'],
  OR: ['test1, [test2, …]', 'TRUE if any test holds'],
  NOT: ['test', 'The opposite of a test'],
  COUNTIF: ['range, criterion', 'How many cells match, e.g. ">10" or "a*"'],
  COUNTIFS: ['range1, criterion1, [range2, criterion2, …]', 'How many rows match every criterion'],
  SUMIF: ['range, criterion, [sum_range]', 'Adds the cells that match'],
  SUMIFS: ['sum_range, range1, criterion1, […]', 'Adds the rows that match every criterion'],
  AVERAGEIF: ['range, criterion, [average_range]', 'The mean of the cells that match'],
  AVERAGEIFS: ['average_range, range1, criterion1, […]', 'The mean of the rows that match every criterion'],
  MAXIFS: ['max_range, range1, criterion1, […]', 'The largest value among rows that match'],
  MINIFS: ['min_range, range1, criterion1, […]', 'The smallest value among rows that match'],
  ISBLANK: ['value', 'TRUE if the cell is empty'],
  ISNUMBER: ['value', 'TRUE if the value is a number'],
  ISTEXT: ['value', 'TRUE if the value is text'],
  ISERROR: ['value', 'TRUE if the value is an error'],
  NA: ['', 'The #N/A error'],
  // lookups
  XLOOKUP: ['search, lookup_range, return_range, [if_not_found], [match_mode], [search_mode]', 'Finds a value and returns the matching cell (match_mode 0 exact, -1/1 nearest, 2 wildcards; search_mode -1 from the end)'],
  VLOOKUP: ['search, range, column, [approximate]', 'Finds a value in the first column and returns a cell from that row'],
  HLOOKUP: ['search, range, row, [approximate]', 'Finds a value in the first row and returns a cell from that column'],
  MATCH: ['search, range, [type]', 'The position of a value in a range'],
  INDEX: ['range, row, [column]', 'The cell at a row and column of a range'],
  FILTER: ['range, include, [if_empty]', 'The rows (or columns) of a range where include is TRUE, e.g. FILTER(A2:C20, C2:C20>100); spills into the cells below'],
  UNIQUE: ['range', 'The range without repeated rows (any case counts as the same); spills'],
  SORT: ['range, [column], [order]', 'The range sorted by a column (1 = first), order 1 rising or -1 falling; spills'],
  SEQUENCE: ['rows, [columns], [start], [step]', 'Numbers counting up: SEQUENCE(5) is 1 to 5 down a column; spills'],
  TRANSPOSE: ['range', 'The range turned on its side: rows become columns; spills'],
  IMPORTRANGE: ['spreadsheet_link, "Sheet1!A1:C10"', 'Cells from another spreadsheet you can open (its link or id); use it in SUM, VLOOKUP and the like for a range'],
  // text
  CONCAT: ['text1, [text2, …]', 'Joins text together'],
  CONCATENATE: ['text1, [text2, …]', 'Joins text together'],
  TEXTJOIN: ['separator, skip_empty, text1, […]', 'Joins text with a separator'],
  TEXT: ['value, format', 'A number or date as text, e.g. "#,##0.00", "0%" or "dd/mm/yyyy"'],
  LEN: ['text', 'The number of characters'],
  UPPER: ['text', 'Text in capitals'],
  LOWER: ['text', 'Text in small letters'],
  PROPER: ['text', 'Text With Each Word Capitalised'],
  TRIM: ['text', 'Removes extra spaces'],
  LEFT: ['text, [count]', 'The first characters'],
  RIGHT: ['text, [count]', 'The last characters'],
  MID: ['text, start, count', 'Characters from the middle'],
  FIND: ['find, within, [start]', 'Where text appears (case matters)'],
  SEARCH: ['find, within, [start]', 'Where text appears (any case, wildcards allowed)'],
  SUBSTITUTE: ['text, old, new, [which]', 'Replaces text'],
  REPT: ['text, times', 'Text repeated'],
  EXACT: ['text1, text2', 'TRUE if two texts are exactly the same'],
  VALUE: ['text', 'Text turned into a number'],
  CHAR: ['code', 'The character with a code number'],
  CODE: ['text', 'The code number of the first character'],
  // dates
  TODAY: ['', "Today's date"],
  NOW: ['', 'The date and time now'],
  DATE: ['year, month, day', 'A date from its parts'],
  YEAR: ['date', 'The year of a date'],
  MONTH: ['date', 'The month of a date (1–12)'],
  DAY: ['date', 'The day of the month'],
  WEEKDAY: ['date, [type]', 'The day of the week (1 = Sunday; type 2: 1 = Monday)'],
  DAYS: ['end, start', 'Days between two dates'],
  DATEDIF: ['start, end, unit', 'Time between dates in "Y", "M", "D", "YM", "MD" or "YD"'],
  EDATE: ['date, months', 'The same day some months later'],
  EOMONTH: ['date, months', 'The last day of a month some months later'],
  NETWORKDAYS: ['start, end, [holidays]', 'Working days (Monday to Friday) between two dates'],
  WORKDAY: ['start, days, [holidays]', 'The date some working days later'],
};

const IDENT = /[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * What the person is typing at the caret of a formula:
 * { word, start } while a function name is being typed (for suggestions), and
 * { fn, arg } when the caret is inside a function's brackets (arg counts from 0). Either may be absent.
 */
export function formulaContext(text, caret = text.length) {
  if (typeof text !== 'string' || !text.startsWith('=')) return {};
  const before = text.slice(0, caret);
  // Walk the formula so strings and brackets are understood.
  const stack = []; // { fn, arg }
  let inString = false;
  for (let i = 1; i < before.length; i++) {
    const ch = before[i];
    if (inString) { if (ch === '"') { if (before[i + 1] === '"') i++; else inString = false; } continue; }
    if (ch === '"') inString = true;
    else if (ch === '(') { const m = IDENT.exec(before.slice(0, i)); stack.push({ fn: m ? m[0].toUpperCase() : null, arg: 0 }); }
    else if (ch === ')') stack.pop();
    else if (ch === ',' && stack.length) stack[stack.length - 1].arg++;
  }
  if (inString) return { ...inner(stack) };
  const out = inner(stack);
  const m = IDENT.exec(before);
  // A name, not a cell reference (A1) nor part of a number, with nothing like a letter right before it.
  if (m && !/^\$?[A-Za-z]{1,3}\$?\d+$/.test(m[0]) && !/[0-9$:]$/.test(before.slice(0, m.index))) out.word = m[0].toUpperCase(), out.start = m.index;
  return out;
}
const inner = (stack) => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].fn) return { fn: stack[i].fn, arg: stack[i].arg }; return {}; };

/** Function names starting with what's typed (best first), at most `limit`. */
export function suggest(word, names, limit = 8) {
  if (!word) return [];
  const w = word.toUpperCase();
  return names.filter((n) => n.startsWith(w) && n !== w).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
}

/** A function's arguments split for display, with the one the caret is in marked (variadic "…" lists keep the last one marked). */
export function signatureParts(name, arg) {
  const h = HELP[name];
  if (!h) return null;
  const parts = h[0] ? h[0].split(/,\s*/) : [];
  const variadic = parts.findIndex((p) => p.includes('…'));
  const current = Math.min(arg, (variadic >= 0 ? variadic : parts.length) - 1); // past the end of a list: its last named argument
  return { name, parts: parts.map((text, i) => ({ text, current: i === current })), about: h[1] };
}
