// Conditional formatting (Sheets' rules) in OpenDocument spreadsheets, as LibreOffice writes and reads it:
// calcext:conditional-formats at the end of each table, each condition applying a named cell style (its fill,
// text colour and bold). Value comparisons, text tests, blanks and errors, duplicates and unique values, top and
// bottom, above and below average, dates, formulas, data bars and colour scales; both ways. (Other programs that
// don't know LibreOffice's extension leave them out.)

export const CALCEXT_NS = 'xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"';
const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quote = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const val = (v) => (v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v)) ? String(Number(v)) : quote(v));
const sheetRef = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`);
const COMPARE = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', ne: '!=' };
const DATES = { dateToday: 'today', datePast7: 'last-7-days', dateThisMonth: 'this-month' };
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A sheet's rules as calcext:conditional-formats, with the cell styles they apply.
 * `formulaToOds` turns a Sheets formula into OpenFormula ("of:=…"); `cellRef` is the range's first cell.
 */
export function rulesToCalcext(rules, sheetName, formulaToOds, prefix = 'CF') {
  const styles = new Map(); // look → style name
  const styleFor = (r) => {
    const look = { fill: HEX.test(r.fill || '') ? r.fill.toLowerCase() : null, color: HEX.test(r.color || '') ? r.color.toLowerCase() : null, bold: !!r.bold };
    const key = JSON.stringify(look);
    if (!styles.has(key)) styles.set(key, { name: `${prefix}${styles.size + 1}`, look });
    return styles.get(key).name;
  };
  const sh = sheetRef(sheetName);
  let out = '';
  for (const r of rules || []) {
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(String(r.range || '').replace(/\$/g, '').toUpperCase());
    if (!m) continue;
    const first = `${m[1]}${m[2]}`, last = m[3] ? `${m[3]}${m[4]}` : first;
    const target = `${sh}.${first}:${sh}.${last}`;
    const at = `${sh}.${first}`;
    const cond = (value) => `<calcext:condition calcext:apply-style-name="${styleFor(r)}" calcext:value="${x(value)}" calcext:base-cell-address="${x(at)}"/>`;
    const f = (formula) => cond(`formula-is(${formulaToOds(`=${formula}`).replace(/^of:=/, '')})`);
    let inner = null;
    if (COMPARE[r.when]) inner = cond(`${COMPARE[r.when]}${val(r.value)}`);
    else if (r.when === 'between') inner = cond(`between(${val(r.value)},${val(r.value2)})`);
    else if (r.when === 'contains') inner = cond(`contains-text(${quote(r.value)})`);
    else if (r.when === 'notContains') inner = cond(`not-contains-text(${quote(r.value)})`);
    else if (r.when === 'starts') inner = cond(`begins-with(${quote(r.value)})`);
    else if (r.when === 'empty') inner = f(`LEN(TRIM(${first}))=0`);
    else if (r.when === 'notEmpty') inner = f(`LEN(TRIM(${first}))>0`);
    else if (r.when === 'error') inner = cond('is-error');
    else if (r.when === 'duplicate' || r.when === 'unique') inner = cond(r.when);
    else if (r.when === 'top' || r.when === 'bottom') inner = cond(`${r.when}-elements(${Math.max(1, Math.min(1000, Math.trunc(Number(r.value)) || 10))})`);
    else if (r.when === 'aboveAvg') inner = cond('above-average');
    else if (r.when === 'belowAvg') inner = cond('below-average');
    else if (DATES[r.when]) inner = `<calcext:date-is calcext:style="${styleFor(r)}" calcext:date="${DATES[r.when]}"/>`;
    else if (r.when === 'datePast') inner = f(`AND(ISNUMBER(${first}),${first}<TODAY())`);
    else if (r.when === 'dateNext7') inner = f(`AND(ISNUMBER(${first}),${first}>=TODAY(),${first}<=TODAY()+7)`);
    else if (r.when === 'dateBefore' || r.when === 'dateAfter') {
      const v = String(r.value ?? '').trim().toLowerCase();
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      const when = v === 'today' ? 'TODAY()' : d ? `DATE(${+d[1]},${+d[2]},${+d[3]})` : null;
      if (when) inner = f(`AND(ISNUMBER(${first}),${first}${r.when === 'dateBefore' ? '<' : '>'}${when})`);
    } else if (r.when === 'formula') { const fx = String(r.value ?? '').trim().replace(/^=/, ''); if (fx) inner = f(fx); }
    else if (r.when === 'bars') inner = `<calcext:data-bar calcext:positive-color="${HEX.test(r.bar || '') ? r.bar : '#638ec6'}"><calcext:formatting-entry calcext:value="0" calcext:type="auto-minimum"/><calcext:formatting-entry calcext:value="0" calcext:type="auto-maximum"/></calcext:data-bar>`;
    else if (r.when === 'scale') {
      const colours = Array.isArray(r.scale) && r.scale.length >= 2 && r.scale.length <= 3 && r.scale.every((c) => HEX.test(c)) ? r.scale : ['#f8696b', '#ffeb84', '#63be7b'];
      const types = colours.length === 3 ? [['minimum', 0], ['percentile', 50], ['maximum', 0]] : [['minimum', 0], ['maximum', 0]];
      inner = `<calcext:color-scale>${colours.map((c, k) => `<calcext:color-scale-entry calcext:value="${types[k][1]}" calcext:type="${types[k][0]}" calcext:color="${c}"/>`).join('')}</calcext:color-scale>`;
    }
    if (inner) out += `<calcext:conditional-format calcext:target-range-address="${x(target)}">${inner}</calcext:conditional-format>`;
  }
  return {
    xml: out ? `<calcext:conditional-formats>${out}</calcext:conditional-formats>` : '',
    styles: [...styles.values()].map(({ name, look }) => `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties${look.fill ? ` fo:background-color="${look.fill}"` : ''}/><style:text-properties${look.color ? ` fo:color="${look.color}"` : ''}${look.bold ? ' fo:font-weight="bold"' : ''}/></style:style>`),
  };
}

/** Comma-separated arguments, quotes respected (between(1,5), contains-text("a, b")). */
function args(s) {
  const out = []; let cur = '', q = false;
  for (const ch of s) { if (ch === '"') q = !q; if ((ch === ',' || ch === ';') && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; }
  out.push(cur.trim());
  return out;
}
const unquote = (t) => (/^".*"$/.test(t) ? t.slice(1, -1).replace(/""/g, '"') : t);

/**
 * Rules from a table's calcext:conditional-formats element. `look(styleName)` gives a cell style's
 * { fill, color, bold }; `formulaFromOds` turns OpenFormula into a Sheets formula ("=…").
 */
export function rulesFromCalcext(el, { tags, look, formulaFromOds }) {
  const rules = [];
  for (const cf of tags(el, 'calcext:conditional-format')) {
    // (the first range of the target: several are separated by spaces, which a sheet's quoted name may hold too)
    const target = /^(?:'(?:[^']|'')*'|[^ '])*/.exec(String(cf.attribs['calcext:target-range-address'] || ''))[0];
    const m = /^(?:[^.]*\.)?\$?([A-Z]+)\$?(\d+)(?::(?:[^.]*\.)?\$?([A-Z]+)\$?(\d+))?$/.exec(target);
    if (!m) continue;
    const range = `${m[1]}${m[2]}:${m[3] || m[1]}${m[4] || m[2]}`;
    for (const c of tags(cf)) {
      let rule = null;
      const styled = (style) => { const l = look(style) || {}; return { ...(l.fill && { fill: l.fill }), ...(l.color && { color: l.color }), ...(l.bold && { bold: true }) }; };
      if (c.name === 'calcext:condition') {
        const v = String(c.attribs['calcext:value'] || '').trim();
        let k;
        if ((k = /^(>=|<=|!=|>|<|=)(.*)$/.exec(v))) rule = { when: { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte', '=': 'eq', '!=': 'ne' }[k[1]], value: unquote(k[2].trim()) };
        else if ((k = /^between\((.*)\)$/.exec(v))) { const [a, b] = args(k[1]); rule = { when: 'between', value: unquote(a), value2: unquote(b ?? '') }; }
        else if ((k = /^(contains-text|not-contains-text|begins-with)\((.*)\)$/.exec(v))) rule = { when: { 'contains-text': 'contains', 'not-contains-text': 'notContains', 'begins-with': 'starts' }[k[1]], value: unquote(k[2].trim()) };
        else if (v === 'is-error') rule = { when: 'error' };
        else if (v === 'duplicate' || v === 'unique') rule = { when: v };
        else if ((k = /^(top|bottom)-elements\((\d+)\)$/.exec(v))) rule = { when: k[1], value: k[2] };
        else if (v === 'above-average' || v === 'below-average') rule = { when: v === 'above-average' ? 'aboveAvg' : 'belowAvg' };
        else if ((k = /^formula-is\(([\s\S]*)\)$/.exec(v))) {
          const f = formulaFromOds(k[1]).replace(/^=/, '');
          const at = m[1] + m[2];
          const same = (s) => f.replace(/\$/g, '') === s;
          if (same(`LEN(TRIM(${at}))=0`)) rule = { when: 'empty' };
          else if (same(`LEN(TRIM(${at}))>0`)) rule = { when: 'notEmpty' };
          else if (same(`AND(ISNUMBER(${at}),${at}<TODAY())`)) rule = { when: 'datePast' };
          else if (same(`AND(ISNUMBER(${at}),${at}>=TODAY(),${at}<=TODAY()+7)`)) rule = { when: 'dateNext7' };
          else {
            const d = new RegExp(`^AND\\(ISNUMBER\\(${at}\\),${at}([<>])(TODAY\\(\\)|DATE\\((\\d+),(\\d+),(\\d+)\\))\\)$`).exec(f.replace(/\$/g, ''));
            if (d) rule = { when: d[1] === '<' ? 'dateBefore' : 'dateAfter', value: d[3] ? `${d[3]}-${String(d[4]).padStart(2, '0')}-${String(d[5]).padStart(2, '0')}` : 'today' };
            else rule = { when: 'formula', value: `=${f}` };
          }
        }
        if (rule) rule = { ...rule, ...styled(c.attribs['calcext:apply-style-name']) };
      } else if (c.name === 'calcext:date-is') {
        const when = { today: 'dateToday', 'last-7-days': 'datePast7', 'this-month': 'dateThisMonth' }[c.attribs['calcext:date']];
        if (when) rule = { when, ...styled(c.attribs['calcext:style']) };
      } else if (c.name === 'calcext:data-bar') {
        const bar = c.attribs['calcext:positive-color'];
        rule = { when: 'bars', bar: HEX.test(bar || '') ? bar.toLowerCase() : '#638ec6' };
      } else if (c.name === 'calcext:color-scale') {
        const scale = tags(c, 'calcext:color-scale-entry').map((e) => String(e.attribs['calcext:color'] || '').toLowerCase()).filter((h) => HEX.test(h));
        if (scale.length >= 2 && scale.length <= 3) rule = { when: 'scale', scale };
      }
      if (rule && rules.length < 100) rules.push({ id: `o${rules.length + 1}`, range, ...rule });
    }
  }
  return rules;
}
