import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {ignores: ['dist/**', 'release/**', 'node_modules/**', 'components/ui/**', 'hooks/**']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {rules: {'@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}]}},
  {
    files: ['app/**/*.tsx', 'src/**/*.{ts,tsx}'],
    languageOptions: {globals: globals.browser},
    plugins: {'react-hooks': reactHooks},
    rules: {...reactHooks.configs.recommended.rules, 'react-hooks/set-state-in-effect': 'off'},
  },
  {
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'vite.config.ts'],
    languageOptions: {globals: globals.node},
    rules: {'no-empty': ['error', {allowEmptyCatch: true}]},
  },
);
