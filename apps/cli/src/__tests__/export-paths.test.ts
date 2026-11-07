import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportFilePath } from "../commands/export.js";

describe("exportFilePath", () => {
  const out = path.join(path.sep, "tmp", "optio-export");

  it("files a manifest under the output directory", () => {
    expect(exportFilePath(out, "work/nightly-bump.yaml")).toBe(
      path.join(out, "work", "nightly-bump.yaml"),
    );
    expect(exportFilePath("manifests", "prompts/review.yaml")).toBe(
      path.resolve("manifests", "prompts", "review.yaml"),
    );
  });

  it("refuses a path that climbs out of it", () => {
    expect(() => exportFilePath(out, "../.ssh/authorized_keys")).toThrow(/outside/);
    expect(() => exportFilePath(out, "work/../../etc/cron.d/x.yaml")).toThrow(/outside/);
  });

  it("refuses an absolute path and the directory itself", () => {
    expect(() => exportFilePath(out, path.join(path.sep, "etc", "passwd"))).toThrow(/outside/);
    expect(() => exportFilePath(out, ".")).toThrow(/outside/);
    expect(() => exportFilePath(out, "")).toThrow(/outside/);
  });

  it("does not mistake a sibling directory with the same prefix for the output directory", () => {
    expect(() => exportFilePath(out, "../optio-export-2/x.yaml")).toThrow(/outside/);
  });
});
