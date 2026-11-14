// Mail → Attachments: the files people sent you, read from each message's structure (no bodies
// fetched), each with its IMAP part number so it can be opened, downloaded or saved alone.

/** The kinds you can narrow the list to, by file name (then type). */
export const KINDS = {
  pdf: { label: 'PDFs', ext: ['pdf'], type: /^application\/pdf$/ },
  image: { label: 'Pictures', ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg'], type: /^image\// },
  document: { label: 'Documents', ext: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'], type: /^(application\/(msword|rtf|vnd\.openxmlformats-officedocument\.wordprocessingml|vnd\.oasis\.opendocument\.text)|text\/plain)/ },
  spreadsheet: { label: 'Spreadsheets', ext: ['xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers'], type: /^(application\/(vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml|vnd\.oasis\.opendocument\.spreadsheet)|text\/(csv|tab-separated-values))/ },
  presentation: { label: 'Presentations', ext: ['ppt', 'pptx', 'odp', 'key'], type: /^application\/(vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml|vnd\.oasis\.opendocument\.presentation)/ },
  archive: { label: 'Archives', ext: ['zip', '7z', 'rar', 'gz', 'tgz', 'tar'], type: /^application\/(zip|x-7z|x-rar|gzip|x-tar)/ },
};

/** Which kind a file is: its extension first (types in mail are often wrong), then its type. */
export function kindOf(filename, type) {
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  for (const [k, v] of Object.entries(KINDS)) if (ext && v.ext.includes(ext)) return k;
  for (const [k, v] of Object.entries(KINDS)) if (v.type.test(String(type || '').toLowerCase())) return k;
  return 'other';
}

const nameOf = (n) => n.dispositionParameters?.filename || n.parameters?.name || '';

/**
 * The attachments in a message's body structure (as imapflow gives it): parts marked as an
 * attachment, or inline parts with a file name that aren't pictures in the text (no Content-ID).
 * Size is the decoded size, estimated from the encoded one.
 */
export function partsOf(node, out = []) {
  if (!node) return out;
  if (node.childNodes?.length) { for (const c of node.childNodes) partsOf(c, out); return out; }
  const type = String(node.type || '').toLowerCase();
  if (type === 'message/rfc822' && node.disposition !== 'attachment') return out;
  const filename = nameOf(node);
  const isAttachment = node.disposition === 'attachment' || (filename && !node.id && !/^text\/(plain|html)$/.test(type));
  if (!isAttachment) return out;
  const encoded = Number(node.size) || 0;
  const size = String(node.encoding || '').toLowerCase() === 'base64' ? Math.floor(encoded * 3 / 4) : encoded;
  out.push({ part: String(node.part || '1'), filename: filename || (type === 'message/rfc822' ? 'message.eml' : 'attachment'), type, size, kind: kindOf(filename, type) });
  return out;
}

/** A part number as IMAP writes it ("2", "1.3.2"): anything else is refused. */
export const PART_RE = /^\d{1,3}(\.\d{1,3}){0,9}$/;
