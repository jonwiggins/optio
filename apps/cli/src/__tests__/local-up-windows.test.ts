import { describe, it, expect, vi, afterEach } from "vitest";

const runDaemon = vi.hoisted(() => vi.fn(async (_opts: unknown) => {}));
vi.mock("../local/daemon.js", () => ({ runDaemon }));

import { localUpUnsupported } from "../commands/local/up.js";
import { createProgram } from "../program.js";

describe("optio local up on native Windows", () => {
  const platform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("runs anywhere but Windows, and on Windows only with a shell that exists", () => {
    expect(localUpUnsupported("linux", undefined)).toBeNull();
    expect(localUpUnsupported("darwin", undefined)).toBeNull();
    expect(localUpUnsupported("win32", "")).toMatch(/inside WSL/);
    expect(localUpUnsupported("win32", "/bin/bash", () => false)).toMatch(/inside WSL/);
    expect(localUpUnsupported("win32", "C:\\shells\\bash.exe", () => true)).toBeNull();
  });

  it("says why and exits 1 instead of starting a daemon whose terminals can't start", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const saved = process.env.SHELL;
    delete process.env.SHELL;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createProgram().parseAsync([
        "node",
        "optio",
        "--server",
        "https://optio.example.com",
        "--api-key",
        "optio_pat_test",
        "local",
        "up",
      ]);
    } finally {
      if (saved !== undefined) process.env.SHELL = saved;
    }
    expect(runDaemon).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls[0][0]).toMatch(/needs a POSIX shell/);
  });
});
