import tsParser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'coverage/**'] },
  {
    files: ['**/*.{js,mjs}'],
    rules: {
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unexpected-multiline': 'error',
      'no-unsafe-finally': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser },
    rules: {
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unexpected-multiline': 'error',
      'no-unsafe-finally': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error',
    },
  },
];
