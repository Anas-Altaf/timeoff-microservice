/* NFR-17: lint config with domain-import boundaries.
 *
 * Files matched by `src/** /domain/**` may not import framework/IO packages
 * (typeorm, axios, @nestjs/common, @nestjs/core). The existing
 * `domain-purity.spec.ts` enforces the same rule at test time; this lint
 * rule shifts that left so violations are caught at edit time.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: { node: true, jest: true, es2022: true },
  ignorePatterns: ['dist', 'coverage', 'node_modules'],
  rules: {
    // Codebase pragmatics: many service handlers receive arbitrary HCM/HTTP
    // payloads. Forbidding `any` here would just push us to noisy
    // `unknown`+casts everywhere without improving safety. Allow it but
    // continue to use precise types where they exist.
    '@typescript-eslint/no-explicit-any': 'off',
    // Several jest beforeAll/afterAll callbacks return promises but jest
    // itself awaits them — the unused-promise warning is noise here.
    '@typescript-eslint/no-floating-promises': 'off',
    // Empty catches in compensating-credit and idempotency unique-violation
    // paths are intentional (documented inline).
    'no-empty': ['error', { allowEmptyCatch: true }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      files: ['src/**/domain/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'typeorm', message: 'Domain modules must not import typeorm (NFR-17).' },
              { name: 'axios', message: 'Domain modules must not import axios (NFR-17).' },
              { name: '@nestjs/common', message: 'Domain modules must not import @nestjs/common (NFR-17).' },
              { name: '@nestjs/core', message: 'Domain modules must not import @nestjs/core (NFR-17).' },
            ],
            patterns: ['typeorm/*', '@nestjs/*'],
          },
        ],
      },
    },
    {
      files: ['test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};
