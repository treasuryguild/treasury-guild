import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Standard async fetch-in-effect patterns: setState only fires after
      // awaits resolve; the rule can't see through the async boundary.
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
    },
  },
  {
    // core-csl's ESM entry fails on Netlify; runtime values come only from
    // src/lib/cardano/csl.ts (a CommonJS require). Tests run under vitest.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: [{
          name: "@meshsdk/core-csl",
          allowTypeImports: true,
          message: "Load core-csl values through src/lib/cardano/csl.ts.",
        }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Supabase CLI scratch output (generated, gitignored)
    "supabase/.temp/**",
  ]),
]);

export default eslintConfig;
