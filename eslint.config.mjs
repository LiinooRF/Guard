import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({
  baseDirectory: rootDir,
  recommendedConfig: js.configs.recommended,
});

export default defineConfig([
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.next-dev/**',
      '**/node_modules/**',
      '**/next-env.d.ts',
      '.agents/**',
      '.claude/**',
      'apps/mobile/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...compat.config({
    extends: ['next/core-web-vitals', 'next/typescript'],
    settings: {
      next: {
        rootDir: path.join(rootDir, 'apps/web'),
      },
    },
  }),
]);
