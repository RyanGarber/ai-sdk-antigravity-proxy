import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  tsconfig: "tsconfig.tsup.json",
  noExternal: ["antigravity-proxy"],
  dts: {
    compilerOptions: {
      ignoreDeprecations: "6.0",
    },
  },
  clean: true,
  minify: true,
  sourcemap: true,
  target: "es2022",
  platform: "browser",
  outDir: "dist",
});
