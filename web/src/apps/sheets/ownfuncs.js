// Named functions (⋮ → Named functions): formulas of the spreadsheet's own, used like any function,
// such as WITHTAX(amount) = amount * 1.2. These are the rules for writing one.
import { FUNCTION_NAMES, OWN_NAME_RE, OWN_PARAM_RE, parse } from './formula.js';

export const MAX_FUNCTIONS = 100;
const looksLikeCell = (n) => /^[A-Z]{1,3}\d+$/i.test(n);

/** Arguments typed as "price, cost" → ['price', 'cost']. */
export const splitParams = (text) => String(text || '').split(',').map((p) => p.trim()).filter(Boolean);

/** What's wrong with a function being written ({ name, params, body }), or null. `editing`: its old name. */
export function functionProblem(f, list = [], editing = null) {
  const name = String(f.name || '').trim();
  if (!name) return 'Give it a name';
  if (!OWN_NAME_RE.test(name) || looksLikeCell(name)) return 'Names use letters, numbers, _ and ., start with a letter and can’t look like a cell';
  if (FUNCTION_NAMES.includes(name.toUpperCase())) return `${name.toUpperCase()} is already a function`;
  if (list.some((x) => x.name.toUpperCase() === name.toUpperCase() && x.name.toUpperCase() !== String(editing || '').toUpperCase())) return 'There is already a function with that name';
  const params = f.params || [];
  if (params.length > 10) return 'At most 10 arguments';
  const bad = params.find((p) => !OWN_PARAM_RE.test(p) || looksLikeCell(p));
  if (bad) return `“${bad}” can’t be an argument name (letters, numbers and _, not like a cell)`;
  if (new Set(params.map((p) => p.toUpperCase())).size !== params.length) return 'Each argument needs its own name';
  const body = String(f.body || '').trim().replace(/^=/, '');
  if (!body) return 'Write its formula';
  try { parse(body); } catch { return 'The formula can’t be read: check its brackets and commas'; }
  return null;
}

/** A function as it's stored: names in capitals, the formula without "=". */
export const cleanFunction = (f) => ({
  name: String(f.name).trim().toUpperCase(),
  params: (f.params || []).map((p) => p.trim()),
  body: String(f.body).trim().replace(/^=/, ''),
  ...(String(f.description || '').trim() && { description: String(f.description).trim().slice(0, 200) }),
});
