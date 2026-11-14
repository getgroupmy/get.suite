// File requests: the kinds of file one can be limited to (as the server checks them, by the name's extension).
export const REQUEST_KINDS = [
  ['pdf', 'PDFs'], ['pictures', 'Pictures'], ['documents', 'Documents'], ['spreadsheets', 'Spreadsheets'],
  ['presentations', 'Presentations'], ['videos', 'Videos'], ['zip', 'Zip files'],
];

/** "PDFs or pictures, up to 10 MB each", for a request's line in the list ('' when it takes anything). */
export function requestSummary({ accept = [], max_mb: mb = null } = {}) {
  const labels = REQUEST_KINDS.filter(([k]) => accept.includes(k)).map(([, l], i) => (i ? l.toLowerCase() : l));
  const kinds = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels[0] || '';
  const size = mb ? `up to ${mb} MB each` : '';
  if (!kinds && !size) return '';
  return kinds ? `Takes ${kinds}${size ? `, ${size}` : ''}` : `Files ${size}`;
}
