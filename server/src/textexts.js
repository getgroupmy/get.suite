// Code and data files read as plain text: shown as text (or a table, for csv/tsv) in their preview (routes/files.js, the web viewer's 'code'/'table'
// kind in web/src/components/viewkind.js, which keeps the same list) and searched by their words (search.js).
export const TEXT_EXTS = ['json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'csv', 'tsv', 'sql', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'ps1', 'bat', 'css', 'scss', 'less', 'vue', 'svelte',
  'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile', 'tex', 'srt', 'vtt', 'diff', 'patch', 'html', 'htm', 'xhtml', 'svg'];
// Files usually named without an extension that are text (a project's Dockerfile, Makefile, LICENSE, README…).
export const TEXT_NAMES = ['dockerfile', 'makefile', 'gnumakefile', 'license', 'licence', 'copying', 'readme', 'changelog', 'changes', 'authors',
  'contributors', 'contributing', 'notice', 'todo', 'procfile', 'gemfile', 'rakefile', 'vagrantfile', 'jenkinsfile', 'brewfile', 'codeowners'];
export const TEXT_EXT_RE = new RegExp(`(\\.(${TEXT_EXTS.join('|')})|^(${TEXT_NAMES.join('|')}))$`, 'i');
