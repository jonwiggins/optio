import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// `pnpm lint` is a gate (CI's Lint step, check:push): it runs with --max-warnings 0, so every rule
// here is effectively an error. Build output and generated files are ignored, not linted.
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "apps/android/**/build/**",
      "**/.next*/**",
      "**/.turbo/**",
      "**/.claude/**",
      "**/.worktrees/**",
      "**/coverage/**",
      "**/out/**",
      "**/helm/**",
      "**/next-env.d.ts",
      "**/*.generated.*",
      "apps/web/test-results/**",
      "apps/web/playwright-report/**",
      "release/**",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          caughtErrors: "all",
        },
      ],
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      // `import type` / inline `type` specifiers: the Next apps compile with isolatedModules, so
      // a type-only import that looks like a value import is an easy mistake; the fixer rewrites.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        // `typeof import("./x.js")` stays allowed: it is how vi.importActual is typed.
        { prefer: "type-imports", fixStyle: "inline-type-imports", disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-debugger": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@optio/*/src/*"],
              message: "Import from the package's public entry, not its src/ files.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSAsExpression > MemberExpression[object.name='req'][property.name=/^(body|params|query)$/]",
          message: "Validate request input with a Zod schema instead of casting with `as`.",
        },
      ],
    },
  },
  {
    // Command-line tools and test drivers print to stdout on purpose.
    files: [
      "scripts/**",
      "**/scripts/**",
      "apps/cli/**",
      "apps/api/src/db/migrate.ts",
      "**/e2e/**",
    ],
    rules: { "no-console": "off" },
  },
  {
    // Type-aware rules for the Node packages: promises that are dropped, awaited when they are
    // not promises, or passed where a void callback is wanted; assertions that change nothing.
    // Only the files a tsconfig includes (apps/api/e2e and the two packages' tests are outside).
    files: ["apps/api/src/**/*.ts", "apps/cli/src/**/*.ts", "packages/*/src/**/*.ts"],
    ignores: ["packages/shared/src/**/*.test.ts", "packages/ticket-providers/src/**/*.test.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: true }],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-for-in-array": "error",
    },
  },
  {
    // React: hooks called unconditionally, effects declaring what they read.
    files: ["apps/web/**/*.{ts,tsx}", "apps/site/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
