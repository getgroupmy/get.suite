// Code and data files read as plain text: shown as text in their preview (routes/files.js, the web viewer's 'code'
// kind in web/src/components/viewkind.js, which keeps the same list) and searched by their words (search.js).
export const TEXT_EXTS = ['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'tsv', 'sql', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'ps1', 'bat', 'css', 'scss', 'less', 'vue', 'svelte',
  'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile', 'tex', 'srt', 'vtt', 'diff', 'patch'];
export const TEXT_EXT_RE = new RegExp(`\\.(${TEXT_EXTS.join('|')})$`, 'i');
