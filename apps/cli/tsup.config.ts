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
  external: ["ws", "node-pty"],
  // Workspace packages export raw TS (./src/index.ts) — bundle them so the
  // built binary doesn't try to import TS sources at runtime.
  noExternal: ["@optio/shared"],
  shims: false,
});
