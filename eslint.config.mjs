import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/.claude/**",
      "**/.worktrees/**",
      "**/coverage/**",
      "**/out/**",
      "**/helm/**",
      "**/next-env.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "warn",
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
);
