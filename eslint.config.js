import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";
import globals from "globals";

export default defineConfig([
  { ignores: ["**/dist/**", "antigravity-proxy/**"] },
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.es2022, ...globals.node } },
  },
  tseslint.configs.recommended,
]);
