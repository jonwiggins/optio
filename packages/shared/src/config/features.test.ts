import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_TYPES } from "../agent-options/index.js";
import { TRIGGER_TYPES } from "../types/triggers.js";
import { TicketSource } from "../types/ticket.js";
import {
  ALL_CONNECTION_PROVIDERS,
  ALL_GIT_PLATFORMS,
  ALL_RUNTIMES,
  ALL_TICKET_SOURCES,
  ALL_TRIGGERS,
  FEATURE_PRESETS,
  currentFeatures,
  featureAllows,
  featureEnvWarnings,
  featureFilter,
  featureNarrowed,
  featureSettingsGiven,
  featuresFromEnv,
  gitlabOnlyDeployment,
  normalizeFeatures,
} from "./features.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const EVERYTHING = {
  runtimes: [...ALL_RUNTIMES],
  gitPlatforms: [...ALL_GIT_PLATFORMS],
  triggers: [...ALL_TRIGGERS],
  ticketSources: [...ALL_TICKET_SOURCES],
  connectionProviders: [...ALL_CONNECTION_PROVIDERS],
  modelAccess: "any",
  agentPolicyDefaults: false,
};

describe("featuresFromEnv", () => {
  it("offers everything with an empty env: every list, any model access, no built-in rules", () => {
    expect(featuresFromEnv({})).toEqual(EVERYTHING);
    expect(featuresFromEnv({ OPTIO_RUNTIMES: "", OPTIO_TRIGGERS: " , " })).toEqual(EVERYTHING);
  });

  it("knows every runtime, platform, trigger and ticket source Optio has", () => {
    expect([...ALL_RUNTIMES].sort()).toEqual([...AGENT_TYPES].sort());
    expect([...ALL_TRIGGERS].sort()).toEqual([...TRIGGER_TYPES].sort());
    expect([...ALL_TICKET_SOURCES].sort()).toEqual(Object.values(TicketSource).sort());
    expect(ALL_GIT_PLATFORMS).toEqual(["github", "gitlab", "codecommit"]);
    const f = featuresFromEnv({});
    expect(
      [f.runtimes, f.gitPlatforms, f.triggers, f.ticketSources, f.connectionProviders].map(
        (l) => l.length,
      ),
    ).toEqual([7, 3, 14, 5, 12]);
  });

  it("narrows each list to what its env var names, in Optio's order", () => {
    const f = featuresFromEnv({
      OPTIO_RUNTIMES: "opencode,claude-code",
      OPTIO_GIT_PLATFORMS: "gitlab",
      OPTIO_TRIGGERS: "manual,jira",
      OPTIO_TICKET_SOURCES: "jira",
      OPTIO_CONNECTION_PROVIDERS: "postgres,custom-mcp",
    });
    expect(f.runtimes).toEqual(["claude-code", "opencode"]);
    expect(f.gitPlatforms).toEqual(["gitlab"]);
    expect(f.triggers).toEqual(["manual", "jira"]);
    expect(f.ticketSources).toEqual(["jira"]);
    expect(f.connectionProviders).toEqual(["postgres", "custom-mcp"]);
    expect(f.modelAccess).toBe("any");
  });

  it("tolerates whitespace and case, and drops values it doesn't know", () => {
    const f = featuresFromEnv({ OPTIO_RUNTIMES: "  Claude-Code , OPENCODE ,vim,," });
    expect(f.runtimes).toEqual(["claude-code", "opencode"]);
  });

  it("treats a list that names nothing it knows as unset", () => {
    expect(featuresFromEnv({ OPTIO_GIT_PLATFORMS: "svn" }).gitPlatforms).toEqual([
      ...ALL_GIT_PLATFORMS,
    ]);
  });

  it("reads the model access and the built-in rules switch", () => {
    expect(featuresFromEnv({ OPTIO_MODEL_ACCESS: "gateway" }).modelAccess).toBe("gateway");
    expect(featuresFromEnv({ OPTIO_MODEL_ACCESS: " Gateway " }).modelAccess).toBe("gateway");
    expect(featuresFromEnv({ OPTIO_MODEL_ACCESS: "vendor" }).modelAccess).toBe("any");
    for (const on of ["true", "1", "yes", "ON"]) {
      expect(featuresFromEnv({ OPTIO_AGENT_POLICY_DEFAULTS: on }).agentPolicyDefaults).toBe(true);
    }
    for (const off of ["false", "0", "", "maybe"]) {
      expect(featuresFromEnv({ OPTIO_AGENT_POLICY_DEFAULTS: off }).agentPolicyDefaults).toBe(false);
    }
  });

  it("fills the lists left unset from a preset, and an explicit list wins over it", () => {
    const f = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_RUNTIMES: "codex" });
    expect(f.runtimes).toEqual(["codex"]);
    expect(f.gitPlatforms).toEqual([...FEATURE_PRESETS.minimal.gitPlatforms]);
    expect(f.triggers).toEqual([...FEATURE_PRESETS.minimal.triggers]);
    expect(f.ticketSources).toEqual([...FEATURE_PRESETS.minimal.ticketSources]);
    expect(f.connectionProviders).toEqual([...FEATURE_PRESETS.minimal.connectionProviders]);
    // The preset fills lists only: the switches keep their own defaults.
    expect(f.modelAccess).toBe("any");
    expect(f.agentPolicyDefaults).toBe(false);
    expect(featuresFromEnv({ OPTIO_FEATURE_PRESET: "nope" })).toEqual(EVERYTHING);
  });

  it("names only values each list knows in its presets", () => {
    const known: Record<string, readonly string[]> = {
      runtimes: ALL_RUNTIMES,
      gitPlatforms: ALL_GIT_PLATFORMS,
      triggers: ALL_TRIGGERS,
      ticketSources: ALL_TICKET_SOURCES,
      connectionProviders: ALL_CONNECTION_PROVIDERS,
    };
    for (const preset of Object.values(FEATURE_PRESETS)) {
      for (const [feature, values] of Object.entries(preset)) {
        for (const v of values) expect(known[feature]).toContain(v);
      }
    }
  });
});

describe("featureEnvWarnings", () => {
  it("says nothing for an empty or a valid env", () => {
    expect(featureEnvWarnings({})).toEqual([]);
    expect(
      featureEnvWarnings({
        OPTIO_RUNTIMES: "claude-code",
        OPTIO_MODEL_ACCESS: "gateway",
        OPTIO_FEATURE_PRESET: "minimal",
      }),
    ).toEqual([]);
  });

  it("names what it ignores, one line per setting", () => {
    const w = featureEnvWarnings({
      OPTIO_RUNTIMES: "claude-code,vim",
      OPTIO_GIT_PLATFORMS: "svn",
      OPTIO_MODEL_ACCESS: "vendor",
      OPTIO_FEATURE_PRESET: "tiny",
    });
    expect(w).toHaveLength(4);
    expect(w[0]).toMatch(/^OPTIO_RUNTIMES: ignoring vim/);
    expect(w[1]).toMatch(/^OPTIO_GIT_PLATFORMS names nothing Optio knows \(svn\)/);
    expect(w.join("\n")).toMatch(/OPTIO_FEATURE_PRESET=tiny is not a preset/);
    expect(w.join("\n")).toMatch(/OPTIO_MODEL_ACCESS=vendor is not any or gateway/);
  });
});

describe("featureAllows / featureFilter / featureNarrowed", () => {
  it("allows every known value by default and nothing unknown", () => {
    const all = featuresFromEnv({});
    for (const r of ALL_RUNTIMES) expect(featureAllows("runtimes", r, all)).toBe(true);
    expect(featureAllows("runtimes", "vim", all)).toBe(false);
    expect(featureNarrowed("runtimes", all)).toBe(false);
  });

  it("follows a narrowed list, keeping the caller's order", () => {
    const f = featuresFromEnv({ OPTIO_RUNTIMES: "claude-code,opencode" });
    expect(featureAllows("runtimes", "codex", f)).toBe(false);
    expect(featureFilter("runtimes", ["opencode", "codex", "claude-code"], f)).toEqual([
      "opencode",
      "claude-code",
    ]);
    expect(featureNarrowed("runtimes", f)).toBe(true);
    expect(featureNarrowed("triggers", f)).toBe(false);
  });

  it("reads the process env when no features are passed", () => {
    expect(featureAllows("gitPlatforms", "github")).toBe(true);
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    expect(featureAllows("gitPlatforms", "github")).toBe(false);
    expect(featureFilter("gitPlatforms", ["github", "gitlab"])).toEqual(["gitlab"]);
  });
});

describe("gitlabOnlyDeployment", () => {
  it("is false by default and with GitHub offered", () => {
    expect(gitlabOnlyDeployment(featuresFromEnv({}))).toBe(false);
    expect(gitlabOnlyDeployment(featuresFromEnv({ OPTIO_GIT_PLATFORMS: "github,gitlab" }))).toBe(
      false,
    );
    expect(gitlabOnlyDeployment(featuresFromEnv({ OPTIO_GIT_PLATFORMS: "codecommit" }))).toBe(
      false,
    );
  });

  it("is true only when GitLab is the sole platform", () => {
    expect(gitlabOnlyDeployment(featuresFromEnv({ OPTIO_GIT_PLATFORMS: "gitlab" }))).toBe(true);
    expect(
      gitlabOnlyDeployment(featuresFromEnv({ OPTIO_GIT_PLATFORMS: "gitlab,codecommit" })),
    ).toBe(false);
  });
});

describe("normalizeFeatures / currentFeatures", () => {
  it("reads a partial or malformed answer as everything for what it leaves out", () => {
    expect(normalizeFeatures(undefined)).toEqual(EVERYTHING);
    expect(normalizeFeatures("nope")).toEqual(EVERYTHING);
    const f = normalizeFeatures({ runtimes: ["opencode", 3, "vim"], modelAccess: "gateway" });
    expect(f.runtimes).toEqual(["opencode"]);
    expect(f.gitPlatforms).toEqual([...ALL_GIT_PLATFORMS]);
    expect(f.modelAccess).toBe("gateway");
    expect(f.agentPolicyDefaults).toBe(false);
    expect(normalizeFeatures({ runtimes: [] }).runtimes).toEqual([...ALL_RUNTIMES]);
  });

  it("reads what the web layout injected, in a browser", () => {
    vi.stubEnv("OPTIO_RUNTIMES", "codex");
    const g = globalThis as unknown as { window?: unknown };
    const had = "window" in g;
    const before = g.window;
    g.window = { __OPTIO_CONFIG: { features: { runtimes: ["claude-code"] } } };
    try {
      expect(currentFeatures().runtimes).toEqual(["claude-code"]);
      g.window = {};
      expect(currentFeatures().runtimes).toEqual([...ALL_RUNTIMES]);
    } finally {
      if (had) g.window = before;
      else delete g.window;
    }
    expect(currentFeatures().runtimes).toEqual(["codex"]);
  });
});

describe("featureSettingsGiven", () => {
  it("is false with nothing set or only blanks", () => {
    expect(featureSettingsGiven({})).toBe(false);
    expect(featureSettingsGiven({ OPTIO_RUNTIMES: "", OPTIO_MODEL_ACCESS: "  " })).toBe(false);
    expect(featureSettingsGiven({ PATH: "/bin" })).toBe(false);
  });

  it("is true when any list, the preset or a switch is set", () => {
    for (const name of [
      "OPTIO_RUNTIMES",
      "OPTIO_GIT_PLATFORMS",
      "OPTIO_TRIGGERS",
      "OPTIO_TICKET_SOURCES",
      "OPTIO_CONNECTION_PROVIDERS",
      "OPTIO_FEATURE_PRESET",
      "OPTIO_MODEL_ACCESS",
      "OPTIO_AGENT_POLICY_DEFAULTS",
    ]) {
      expect(featureSettingsGiven({ [name]: "x" })).toBe(true);
    }
  });
});
