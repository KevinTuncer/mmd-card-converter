import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "public/**",
      // Legacy reference copies of the converter code — not part of the build
      "JUSTFORCOMPARISON/**",
      // Vendored UPNG library source
      "lib/upng/upng.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mts,mjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // The codebase uses a leading underscore for intentionally unused
      // parameters and variables (e.g. `_encoding`, `_GlobalFonts`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: {
      // Hand-written declarations for vendored libraries legitimately use `any`
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);