// Which files open in the viewer (email attachments, chat files); the server shows only these (server/src/mail/preview.js).
const KINDS = {
  picture: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'],
  pdf: ['pdf'],
  text: ['txt', 'log'],
  table: ['csv', 'tsv'], // shown as a table (headings, rows), or as text
  video: ['mp4', 'webm'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'weba', 'opus'],
  office: ['docx', 'odt', 'xlsx', 'ods', 'pptx', 'odp', 'md', 'markdown'], // (Markdown shown formatted, as a document)
  eml: ['eml'], // an email, shown as text
  // code and data files shown as their text (the server's TEXT_EXTS, server/src/textexts.js, has these and csv/tsv)
  code: ['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'sql', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'ps1', 'bat', 'css', 'scss', 'less', 'vue', 'svelte',
    'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile', 'tex', 'srt', 'vtt', 'diff', 'patch', 'html', 'htm', 'xhtml', 'svg'], // (HTML and SVG as their source: nothing in them runs)
  cards: ['ics', 'vcf'], // a calendar file's events or contact cards' people, to add to Calendar or Contacts
  zip: ['zip'], // a list of what's inside // converted on the server and shown as Docs, Sheets or Slides would
};
const BY_EXT = Object.fromEntries(Object.entries(KINDS).flatMap(([k, exts]) => exts.map((e) => [e, k])));

/** 'picture' | 'pdf' | 'text' | 'video' | 'audio' | 'office' | 'eml' | 'cards' | 'code' | 'table' | 'zip', or null for attachments that only download. */
// Files usually named without an extension that are text (as the server's TEXT_NAMES): shown as code.
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'gnumakefile', 'license', 'licence', 'copying', 'readme', 'changelog', 'changes', 'authors',
  'contributors', 'contributing', 'notice', 'todo', 'procfile', 'gemfile', 'rakefile', 'vagrantfile', 'jenkinsfile', 'brewfile', 'codeowners']);

export function previewKind(filename) {
  const name = String(filename || '');
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return (m && BY_EXT[m[1].toLowerCase()]) || (TEXT_NAMES.has(name.toLowerCase()) ? 'code' : null);
}

/** The next attachment that can be shown, going forward (+1) or back (-1) from index i, round the list. */
export function stepPreview(attachments, i, dir) {
  const n = attachments.length;
  for (let k = 1; k <= n; k++) {
    const j = (((i + dir * k) % n) + n) % n;
    if (previewKind(attachments[j].filename)) return j;
  }
  return i;
}
