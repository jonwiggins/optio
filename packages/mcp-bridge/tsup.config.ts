import { defineConfig } from "tsup";

// One self-contained file: baked into the agent images at
// /opt/optio/mcp-bridge.js and launched as `node /opt/optio/mcp-bridge.js`.
export default defineConfig({
  entry: { "mcp-bridge": "src/index.ts" },
  format: "esm",
  target: "node22",
  bundle: true,
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  outDir: "dist",
  clean: true,
  dts: false,
  noExternal: [/.*/],
  shims: false,
});
