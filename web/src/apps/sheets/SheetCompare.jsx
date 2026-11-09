// Compare spreadsheets (Sheets): how another spreadsheet, or an Excel or CSV file, differs from this
// one, cell by cell and sheet by sheet: by what the cells come to (the standard), or by formulas as typed.
import { useMemo, useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { SheetChanges } from './SheetPreview.jsx';
import { asValues } from './sheetdiff.js';
import { bookEvaluator, display } from './formula.js';

const evaluatorFor = (sheets, i) => bookEvaluator(sheets, i);
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function CompareSheets({ name, other, current, onClose }) {
  const [swapped, setSwapped] = useState(false);
  const [values, setValues] = useState(true);
  const [mine, theirs] = useMemo(() => (values
    ? [asValues(current, evaluatorFor, display), asValues(other.content, evaluatorFor, display)]
    : [current, other.content]), [current, other.content, values]);
  const [from, to] = swapped ? [other.name, name] : [name, other.name];
  return (
    <Modal wide title="Compare spreadsheets" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      <div className="row wrap small" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <span>From <strong>{from}</strong> to <strong>{to}</strong></span>
        <button type="button" className="btn small" onClick={() => setSwapped(!swapped)}>⇄ Swap</button>
        <div className="seg" role="radiogroup" aria-label="Compare">
          {[[true, 'Results'], [false, 'Formulas']].map(([v, l]) => <button key={l} type="button" role="radio" aria-checked={values === v} className={values === v ? 'on' : ''} onClick={() => setValues(v)}>{l}</button>)}
        </div>
      </div>
      <div className="compare-body">
        <SheetChanges key={`${swapped}-${values}`} before={swapped ? theirs : mine} after={swapped ? mine : theirs} labels={[from, to]} sheetWords={{ added: `only in ${to}`, removed: `only in ${from}`, was: (n) => `called ${n} in ${from}` }}
          summary={(t, n) => (n ? `${plural(t.cells, 'cell')} differ${t.cells === 1 ? 's' : ''}${t.sheets ? `; ${plural(t.sheets, 'sheet')} only in one of them, or named differently` : ''}.` : `The ${values ? 'results' : 'cells'} are the same.`)} />
      </div>
    </Modal>
  );
}
