import { describe, expect, it } from "vitest";
import { parseClaudeHelp, parseCodexModels } from "../local/cli-probes.js";

// Trimmed from `claude --help` (Claude Code 2.1.282): the choices wrap
// across lines, and `default` (Manual's config value) isn't listed.
const HELP_2_1_282 = `Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  -p, --print                           Print response and exit
`;

// An older release: no auto mode, no --effort.
const HELP_OLD = `Options:
  --permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")
  -p, --print               Print response and exit
`;

describe("parseClaudeHelp", () => {
  it("reads the permission modes and --effort from a current claude", () => {
    const caps = parseClaudeHelp(HELP_2_1_282);
    expect(caps?.effort).toBe(true);
    expect(caps?.permissionModes).toEqual(
      expect.arrayContaining(["auto", "bypassPermissions", "manual", "default"]),
    );
  });

  it("knows an older claude has neither auto mode nor --effort", () => {
    const caps = parseClaudeHelp(HELP_OLD);
    expect(caps?.effort).toBe(false);
    expect(caps?.permissionModes).not.toContain("auto");
    expect(caps?.permissionModes).toContain("default");
  });

  it("leaves the modes unknown when the help doesn't list them", () => {
    expect(
      parseClaudeHelp("  --permission-mode <mode>  Permission mode to use\n  --effort <level>\n"),
    ).toEqual({ permissionModes: null, effort: true });
  });

  it("is null for anything that isn't Claude Code's help", () => {
    expect(parseClaudeHelp("zsh: command not found: claude")).toBeNull();
    expect(parseClaudeHelp("")).toBeNull();
  });
});

// Shaped like `codex debug models` (Codex 0.146), minus the long fields.
const CATALOG = {
  models: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Frontier model for complex coding.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
      ],
      visibility: "list",
      priority: 7,
    },
    {
      slug: "codex-auto-review",
      display_name: "Codex Auto Review",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }],
      visibility: "hide",
      priority: 43,
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      description: "Latest frontier agentic coding model.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" },
      ],
      visibility: "list",
      priority: 1,
      base_instructions: "You are Codex…",
    },
  ],
};

describe("parseCodexModels", () => {
  it("lists Codex's picker models in its priority order with their efforts", () => {
    expect(parseCodexModels(JSON.stringify(CATALOG))).toEqual([
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6-Sol",
        description: "Latest frontier agentic coding model.",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultEffort: "low",
      },
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        description: "Frontier model for complex coding.",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
      },
    ]);
  });

  it("reads through a login shell's banner", () => {
    const models = parseCodexModels(`Welcome back!\n${JSON.stringify(CATALOG)}\n`);
    expect(models?.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("reads Codex's models_cache.json the same way", () => {
    const cache = { fetched_at: "2026-09-01T00:00:00Z", client_version: "0.146.0", ...CATALOG };
    expect(parseCodexModels(JSON.stringify(cache))?.[0].id).toBe("gpt-5.6-sol");
  });

  it("drops efforts that aren't plain words", () => {
    const odd = {
      models: [
        {
          slug: "m",
          supported_reasoning_levels: [{ effort: "high" }, { effort: "x; rm" }, "low"],
          default_reasoning_level: "$(id)",
        },
      ],
    };
    expect(parseCodexModels(JSON.stringify(odd))).toEqual([
      { id: "m", label: "m", efforts: ["high", "low"], defaultEffort: null },
    ]);
  });

  it("is null for output that isn't a catalog", () => {
    expect(parseCodexModels("zsh: command not found: codex")).toBeNull();
    expect(parseCodexModels('{"error":"nope"}')).toBeNull();
    expect(parseCodexModels('{"models":[{"slug":"x","visibility":"hide"}]}')).toBeNull();
  });
});
