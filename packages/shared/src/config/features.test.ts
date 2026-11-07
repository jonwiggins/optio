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
  FEATURE_SETTINGS,
  currentFeatures,
  featureAllows,
  featureEnvWarnings,
  featureFilter,
  featureNarrowed,
  featureSettingsGiven,
  featuresFromEnv,
  normalizeFeatures,
} from "./features.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const EVERYTHING = {
  modelAccess: "any",
  runtimes: [...ALL_RUNTIMES],
  gitPlatforms: [...ALL_GIT_PLATFORMS],
  triggers: [...ALL_TRIGGERS],
  ticketSources: [...ALL_TICKET_SOURCES],
  connectionProviders: [...ALL_CONNECTION_PROVIDERS],
};

describe("featuresFromEnv", () => {
  it("offers everything with an empty env", () => {
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
    ).toEqual([8, 3, 14, 5, 13]);
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

  it("narrows one list alone: the others still offer everything", () => {
    const f = featuresFromEnv({ OPTIO_RUNTIMES: "codex" });
    expect(f.runtimes).toEqual(["codex"]);
    expect(f.gitPlatforms).toEqual([...ALL_GIT_PLATFORMS]);
    expect(f.triggers).toEqual([...ALL_TRIGGERS]);
  });
});

describe("featureEnvWarnings", () => {
  it("says nothing for an empty or a valid env", () => {
    expect(featureEnvWarnings({})).toEqual([]);
    expect(featureEnvWarnings({ OPTIO_RUNTIMES: "claude-code", OPTIO_TRIGGERS: "" })).toEqual([]);
  });

  it("names what it ignores, one line per setting", () => {
    const w = featureEnvWarnings({
      OPTIO_RUNTIMES: "claude-code,vim",
      OPTIO_GIT_PLATFORMS: "svn",
    });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/^OPTIO_RUNTIMES: ignoring vim/);
    expect(w[1]).toMatch(/^OPTIO_GIT_PLATFORMS names nothing Optio knows \(svn\)/);
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

describe("normalizeFeatures / currentFeatures", () => {
  it("reads a partial or malformed answer as everything for what it leaves out", () => {
    expect(normalizeFeatures(undefined)).toEqual(EVERYTHING);
    expect(normalizeFeatures("nope")).toEqual(EVERYTHING);
    const f = normalizeFeatures({ runtimes: ["opencode", 3, "vim"] });
    expect(f.runtimes).toEqual(["opencode"]);
    expect(f.gitPlatforms).toEqual([...ALL_GIT_PLATFORMS]);
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
    expect(featureSettingsGiven({ OPTIO_RUNTIMES: "", OPTIO_TRIGGERS: "  " })).toBe(false);
    expect(featureSettingsGiven({ PATH: "/bin" })).toBe(false);
  });

  it("is true when any list is set", () => {
    expect(FEATURE_SETTINGS).toEqual([
      "OPTIO_RUNTIMES",
      "OPTIO_GIT_PLATFORMS",
      "OPTIO_TRIGGERS",
      "OPTIO_TICKET_SOURCES",
      "OPTIO_CONNECTION_PROVIDERS",
      "OPTIO_MODEL_ACCESS",
    ]);
    for (const name of FEATURE_SETTINGS) {
      expect(featureSettingsGiven({ [name]: "x" })).toBe(true);
    }
  });
});

// Original model-gateway deployment setting (split29).
describe("gateway model access", () => {
  it("normalizes the gateway-only env value and ignores an unknown one", () => {
    expect(featuresFromEnv({ OPTIO_MODEL_ACCESS: "gateway" }).modelAccess).toBe("gateway");
    expect(featuresFromEnv({ OPTIO_MODEL_ACCESS: " Gateway " }).modelAccess).toBe("gateway");
    expect(featuresFromEnv({ OPTIO_MODEL_ACCESS: "vendor" }).modelAccess).toBe("any");
    expect(featureEnvWarnings({ OPTIO_MODEL_ACCESS: "vendor" }).join("\n")).toMatch(
      /OPTIO_MODEL_ACCESS=vendor is not any or gateway/,
    );
    expect(normalizeFeatures({ modelAccess: "gateway" }).modelAccess).toBe("gateway");
    expect(featureSettingsGiven({ OPTIO_MODEL_ACCESS: "gateway" })).toBe(true);
  });
});
