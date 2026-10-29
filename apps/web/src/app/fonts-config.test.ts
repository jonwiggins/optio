import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

const require = createRequire(import.meta.url);
const bundled = require("next/dist/compiled/webpack/webpack");
bundled.init();
const { webpack } = bundled;
const { JsConfigPathsPlugin } = require("next/dist/build/webpack/plugins/jsconfig-paths-plugin");

afterEach(() => vi.unstubAllEnvs());

describe("the web build's fonts", () => {
  it.each([undefined, "0", "1"])(
    "OPTIO_OFFLINE_FONTS=%s resolves the expected font module",
    async (flag) => {
      vi.stubEnv("OPTIO_OFFLINE_FONTS", flag);
      const root = path.resolve(import.meta.dirname, "../..");
      const out = await mkdtemp(path.join(root, "node_modules/.fonts-test-"));
      try {
        // Use Next's actual tsconfig resolver and webpack. Externalizing font
        // loaders lets this check the selected import without downloading fonts.
        const config = nextConfig.webpack!(
          {
            mode: "development",
            devtool: false,
            context: root,
            entry: "@/app/fonts",
            output: { path: out, filename: "fonts.cjs" },
            target: "node",
            resolve: {
              extensions: [".ts", ".js"],
              alias: {},
              plugins: [
                new JsConfigPathsPlugin(
                  { "@/*": ["./src/*"] },
                  { baseUrl: root, isImplicit: true },
                ),
              ],
            },
            module: { rules: [{ test: /\.ts$/, type: "javascript/auto" }] },
            plugins: [],
            externals: ["next/font/google", "next/font/local"],
            externalsType: "commonjs",
          },
          { webpack } as never,
        );
        const compiler = webpack(config);
        try {
          await new Promise<void>((resolve, reject) =>
            compiler.run((err: Error | null, stats: any) => {
              if (err) return reject(err);
              if (stats.hasErrors())
                return reject(new Error(stats.toString({ all: false, errors: true })));
              resolve();
            }),
          );
        } finally {
          await new Promise<void>((resolve, reject) =>
            compiler.close((err: Error | null) => (err ? reject(err) : resolve())),
          );
        }
        const bundle = await readFile(path.join(out, "fonts.cjs"), "utf8");
        expect(bundle).toContain(
          flag === "1" ? 'require("next/font/local")' : 'require("next/font/google")',
        );
        expect(bundle).not.toContain(
          flag === "1" ? 'require("next/font/google")' : 'require("next/font/local")',
        );
        if (flag === "1") expect(bundle).toContain("sora-latin-wght.woff2");
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
  );
});
