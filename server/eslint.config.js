// Lint for bugs, not style: names that aren't defined, unreachable code, duplicate keys and the like.
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'data/**'] },
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-dupe-else-if': 'error',
      'no-self-assign': 'error', 'no-unsafe-finally': 'error', 'no-const-assign': 'error', 'no-func-assign': 'error', 'no-import-assign': 'error', 'valid-typeof': 'error',
    },
  },
];
