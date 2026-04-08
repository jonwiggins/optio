import { defineConfig } from "tsup";
export default defineConfig({
  entry: { optio: "src/index.ts" },
  format: "esm",
  target: "node20",
  bundle: true,
  minify: false,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  outDir: "dist",
  clean: true,
  dts: false,
  external: ["ws"],
  shims: false,
});
