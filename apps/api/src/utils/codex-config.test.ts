import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITE_SETUP_FILES } from "./pod-env.js";
import {
  codexMcpConfigToml,
  EXPORT_CODEX_HOME,
  newCodexHome,
  tomlKey,
  tomlString,
} from "./codex-config.js";

describe("codexMcpConfigToml", () => {
  it("renders each server as a [mcp_servers.<name>] table with its args and env", () => {
    const toml = codexMcpConfigToml({
      docs: { command: "docs-mcp", args: [] },
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
      },
    });
    expect(toml).toBe(
      [
        "[mcp_servers.docs]",
        'command = "docs-mcp"',
        "args = []",
        "",
        "[mcp_servers.github]",
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-github"]',
        "",
        "[mcp_servers.github.env]",
        'GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_x"',
        "",
      ].join("\n"),
    );
  });

  it("quotes names and values TOML would otherwise misread", () => {
    expect(tomlKey("my server")).toBe('"my server"');
    expect(tomlKey("my-server_1")).toBe("my-server_1");
    expect(tomlString('a "quoted" \\ path\n\ttab\u0001')).toBe(
      '"a \\"quoted\\" \\\\ path\\n\\ttab\\u0001"',
    );
    const toml = codexMcpConfigToml({
      "my server": { command: "C:\\mcp.exe", args: ['say "hi"'], env: { "K.1": "v" } },
    });
    expect(toml).toContain('[mcp_servers."my server"]');
    expect(toml).toContain('command = "C:\\\\mcp.exe"');
    expect(toml).toContain('args = ["say \\"hi\\""]');
    expect(toml).toContain('"K.1" = "v"');
  });

  it("is empty with no servers", () => {
    expect(codexMcpConfigToml({})).toBe("");
  });
});

describe("newCodexHome", () => {
  it("names a per-run home under /opt/optio, which lands in the agent's home", () => {
    const a = newCodexHome();
    const b = newCodexHome();
    expect(a.setupPath).toMatch(/^\/opt\/optio\/codex\/[0-9a-f]{12}\/config\.toml$/);
    expect(a.podPath).toBe(
      a.setupPath.replace("/opt/optio/", "/home/agent/optio/").replace(/\/config\.toml$/, ""),
    );
    expect(a.podPath).not.toBe(b.podPath);
  });
});

describe("EXPORT_CODEX_HOME", () => {
  it("exports CODEX_HOME only when the run has one", () => {
    const run = (env: Record<string, string>) =>
      execFileSync(
        "bash",
        ["-c", [...EXPORT_CODEX_HOME, 'echo "${CODEX_HOME:-unset}"'].join("\n")],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", ...env },
        },
      ).trim();
    expect(run({})).toBe("unset");
    expect(run({ OPTIO_CODEX_HOME: "/home/agent/optio/codex/abc" })).toBe(
      "/home/agent/optio/codex/abc",
    );
  });

  it("the setup-file writer puts the config where CODEX_HOME points (with a home of this test's own)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      const home = newCodexHome();
      const files = [{ path: home.setupPath, content: 'command = "x"\n', sensitive: true }];
      // The pod maps /opt/optio/ to /home/agent/optio/; here that prefix is
      // rewritten to the temp dir so the test needs no /home/agent.
      const script = WRITE_SETUP_FILES.join("\n").replace("/home/agent/optio/", `${dir}/optio/`);
      execFileSync("bash", ["-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          OPTIO_SETUP_FILES: Buffer.from(JSON.stringify(files)).toString("base64"),
        },
      });
      const written = join(
        home.podPath.replace("/home/agent/optio/", `${dir}/optio/`),
        "config.toml",
      );
      expect(readFileSync(written, "utf8")).toBe('command = "x"\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
