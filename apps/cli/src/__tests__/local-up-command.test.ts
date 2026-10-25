import { describe, it, expect, vi, beforeEach } from "vitest";

const runDaemon = vi.hoisted(() => vi.fn(async (_opts: unknown) => {}));
vi.mock("../local/daemon.js", () => ({ runDaemon }));

import { createProgram } from "../program.js";

function parse(args: string[]) {
  return createProgram().parseAsync([
    "node",
    "optio",
    "--server",
    "https://optio.example.com",
    "--api-key",
    "optio_pat_test",
    "local",
    "up",
    ...args,
  ]);
}

describe("optio local up", () => {
  beforeEach(() => {
    runDaemon.mockClear();
  });

  // The commands are module singletons that keep option values between
  // parses (commander 12): the default case goes first.
  it("passes no extra directories and no name by default", async () => {
    await parse([]);
    expect(runDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ remoteDirs: true, dirs: [], name: undefined }),
    );
  });

  it("passes every --dir, --name and --no-remote-dirs to the daemon", async () => {
    await parse([
      "--no-remote-dirs",
      "--dir",
      "/home/coder/repo",
      "--dir",
      "/srv/data",
      "--name",
      "alice-fix-login",
    ]);
    expect(runDaemon).toHaveBeenCalledTimes(1);
    expect(runDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteDirs: false,
        dirs: ["/home/coder/repo", "/srv/data"],
        name: "alice-fix-login",
      }),
    );
  });
});
