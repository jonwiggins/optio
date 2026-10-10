import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  carriesEnv,
  copilotMcpConfigFlag,
  copilotMcpConfigJson,
  cursorMcpJson,
  EXPORT_GEMINI_HOME,
  EXPORT_OPENCODE_CONFIG,
  geminiSettingsJson,
  opencodeConfigJson,
  REMOVE_RUN_HOME,
  removeRunHome,
  runHome,
  runHomePath,
} from "./harness-config.js";

const servers = {
  docs: { command: "docs-mcp", args: [] },
  "Support Pylon": {
    command: "node",
    args: ["/opt/optio/mcp-bridge.js"],
    env: { OPTIO_HTTP_AUTH_VALUE: "Bearer pyl_t", OPTIO_HTTP_NAME: "Support Pylon" },
  },
};

const bash = (lines: readonly string[], env: Record<string, string> = {}, cwd?: string) =>
  execFileSync("bash", ["-c", lines.join("\n")], {
    encoding: "utf8",
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
  }).trim();

describe("runHome", () => {
  it("is named after the run, under /opt/optio for the writer and /home/agent/optio in the pod", () => {
    const id = "4d1b6c0e-6a2a-4b7e-9a7c-1f2e3d4c5b6a";
    expect(runHome(id)).toEqual({
      setupDir: `/opt/optio/runs/${id}`,
      podDir: `/home/agent/optio/runs/${id}`,
    });
    expect(runHome(id)).toEqual(runHome(id));
    expect(runHomePath(id)).toBe(`/home/agent/optio/runs/${id}`);
    expect(removeRunHome(id)).toBe(`rm -rf '/home/agent/optio/runs/${id}'`);
  });

  it("takes a random name for a missing or unsafe id, and removes nothing for one", () => {
    expect(runHome().podDir).toMatch(/^\/home\/agent\/optio\/runs\/[0-9a-f]{12}$/);
    expect(runHome(null).podDir).not.toBe(runHome(null).podDir);
    expect(runHome("../etc").podDir).toMatch(/^\/home\/agent\/optio\/runs\/[0-9a-f]{12}$/);
    expect(runHomePath("../etc")).toBeNull();
    expect(removeRunHome("a b; rm -rf /")).toBe("true");
  });
});

describe("renderers", () => {
  it("Gemini: the adapter's settings plus every server, trusted, env kept", () => {
    const json = JSON.parse(
      geminiSettingsJson({ model: { maxSessionTurns: 5 }, telemetry: { enabled: false } }, servers),
    );
    expect(json.model).toEqual({ maxSessionTurns: 5 });
    expect(json.telemetry).toEqual({ enabled: false });
    expect(json.mcpServers).toEqual({
      docs: { command: "docs-mcp", args: [], trust: true },
      "Support Pylon": {
        command: "node",
        args: ["/opt/optio/mcp-bridge.js"],
        env: servers["Support Pylon"].env,
        trust: true,
      },
    });
  });

  it("OpenCode: `mcp` entries with the command and args as one list", () => {
    const json = JSON.parse(opencodeConfigJson(servers));
    expect(json.$schema).toBe("https://opencode.ai/config.json");
    expect(json.mcp).toEqual({
      docs: { type: "local", command: ["docs-mcp"], enabled: true },
      "Support Pylon": {
        type: "local",
        command: ["node", "/opt/optio/mcp-bridge.js"],
        environment: servers["Support Pylon"].env,
        enabled: true,
      },
    });
  });

  it("Cursor: the .mcp.json shape", () => {
    expect(JSON.parse(cursorMcpJson(servers))).toEqual({
      mcpServers: {
        docs: { command: "docs-mcp", args: [] },
        "Support Pylon": {
          command: "node",
          args: ["/opt/optio/mcp-bridge.js"],
          env: servers["Support Pylon"].env,
        },
      },
    });
  });

  it("Copilot: local servers with every tool enabled", () => {
    expect(JSON.parse(copilotMcpConfigJson(servers))).toEqual({
      mcpServers: {
        docs: { type: "local", command: "docs-mcp", args: [], tools: ["*"] },
        "Support Pylon": {
          type: "local",
          command: "node",
          args: ["/opt/optio/mcp-bridge.js"],
          env: servers["Support Pylon"].env,
          tools: ["*"],
        },
      },
    });
  });

  it("keeps hostile names and values as data", () => {
    const hostile = {
      'a"b\n$(id)': { command: "x", args: ["'; rm -rf /"], env: { K: '"}' } },
    };
    for (const text of [
      geminiSettingsJson({}, hostile),
      opencodeConfigJson(hostile),
      cursorMcpJson(hostile),
      copilotMcpConfigJson(hostile),
    ]) {
      const parsed = JSON.parse(text);
      const entry = (parsed.mcpServers ?? parsed.mcp)['a"b\n$(id)'];
      expect(entry).toBeDefined();
      expect(JSON.stringify(entry)).toContain("rm -rf /");
    }
  });

  it("says whether any server carries env", () => {
    expect(carriesEnv(servers)).toBe(true);
    expect(carriesEnv({ docs: servers.docs })).toBe(false);
    expect(carriesEnv({ e: { command: "x", args: [], env: {} } })).toBe(false);
  });
});

describe("launch lines", () => {
  it("export Gemini's home and OpenCode's config only when the run has one", () => {
    const gemini = [...EXPORT_GEMINI_HOME, 'echo "${GEMINI_CLI_HOME:-unset}"'];
    expect(bash(gemini)).toBe("unset");
    expect(bash(gemini, { OPTIO_GEMINI_HOME: "/home/agent/optio/runs/r1/gemini" })).toBe(
      "/home/agent/optio/runs/r1/gemini",
    );
    const opencode = [...EXPORT_OPENCODE_CONFIG, 'echo "${OPENCODE_CONFIG:-unset}"'];
    expect(bash(opencode)).toBe("unset");
    expect(
      bash(opencode, { OPTIO_OPENCODE_CONFIG: "/home/agent/optio/runs/r1/opencode/opencode.json" }),
    ).toBe("/home/agent/optio/runs/r1/opencode/opencode.json");
  });

  it("names Copilot's config file with an @, quoted", () => {
    expect(copilotMcpConfigFlag({})).toBe("");
    expect(
      copilotMcpConfigFlag({
        OPTIO_COPILOT_MCP_CONFIG: "/home/agent/optio/runs/r1/copilot/mcp-config.json",
      }),
    ).toBe(" --additional-mcp-config '@/home/agent/optio/runs/r1/copilot/mcp-config.json'");
  });
});

describe("REMOVE_RUN_HOME", () => {
  it("removes the run's home from an EXIT trap, and only a home under the runs directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-home-"));
    try {
      // The pod's runs directory, stood in for by a temp dir.
      const line = REMOVE_RUN_HOME.replaceAll("/home/agent/optio/runs", `${dir}/runs`);
      expect(line).not.toContain("'");
      const home = join(dir, "runs", "r1");
      mkdirSync(join(home, "codex"), { recursive: true });
      writeFileSync(join(home, "codex", "config.toml"), "x");
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(elsewhere);

      bash([`trap '${line}' EXIT`, "true"], { OPTIO_RUN_HOME: home });
      expect(existsSync(home)).toBe(false);

      bash([`trap '${line}' EXIT`, "true"], { OPTIO_RUN_HOME: elsewhere });
      expect(existsSync(elsewhere)).toBe(true);
      bash([`trap '${line}' EXIT`, "true"], {});
      expect(existsSync(elsewhere)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
