import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    noExternal: ["antigravity-proxy"],
    dts: {
      compilerOptions: {
        ignoreDeprecations: "6.0",
      },
    },
    minify: true,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
    outDir: "dist",
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    outDir: "dist",
  },
]);
