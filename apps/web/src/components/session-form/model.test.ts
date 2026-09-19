import { describe as suite, it, expect } from "vitest";
import {
  EMPTY_DRAFT,
  PRESETS,
  SHELL,
  describe,
  deriveKind,
  missingFields,
  normalize,
  runtimeOptions,
  whenOptions,
  type SessionDraft,
} from "./model";

const local = (d: SessionDraft, dir = "/Users/dev/repos/app"): SessionDraft => ({
  ...d,
  location: { ...d.location, runTarget: "local", localHostId: "h1", localDir: dir },
});
const text = (d: SessionDraft, ctx?: Parameters<typeof describe>[1]) =>
  describe(d, ctx)
    .map((p) => ("missing" in p ? `[${p.missing}]` : p.text))
    .join(" ")
    .replace(" .", ".");

suite("deriveKind — every kind is a point in the five-attribute space", () => {
  const base = { ...EMPTY_DRAFT, title: "t", prompt: "p" };

  it("exits + pod + repo", () => {
    expect(deriveKind(base)).toBe("repo-task");
    expect(deriveKind({ ...base, when: "schedule" })).toBe("repo-blueprint");
  });

  it("exits + no repo", () => {
    expect(deriveKind({ ...base, withRepo: false })).toBe("standalone");
    expect(deriveKind({ ...base, withRepo: false, when: "webhook" })).toBe("standalone");
    expect(deriveKind(local({ ...base, withRepo: false, when: "schedule" }))).toBe("standalone");
  });

  it("exits + machine + event trigger is a Local automation", () => {
    expect(deriveKind(local({ ...base, when: "github" }))).toBe("local-blueprint");
  });

  it("waits for me", () => {
    expect(deriveKind(local({ ...base, then: "waits-for-me" }))).toBe("local-terminal");
    expect(deriveKind(local({ ...base, then: "waits-for-me", when: "slack" }))).toBe(
      "local-blueprint",
    );
    expect(deriveKind({ ...base, then: "waits-for-me" })).toBe("pod-session");
  });

  it("waits for messages", () => {
    expect(deriveKind({ ...base, then: "waits-for-messages" })).toBe("persistent-agent");
  });
});

suite("normalize — Then / Where constrain the rest", () => {
  it("moves a persistent agent to a pod and drops its repo", () => {
    const d = normalize(local({ ...EMPTY_DRAFT, then: "waits-for-messages" }));
    expect(d.location.runTarget).toBe("cluster");
    expect(d.withRepo).toBe(false);
  });

  it("forces a repo for a pod terminal", () => {
    expect(normalize({ ...EMPTY_DRAFT, then: "waits-for-me", withRepo: false }).withRepo).toBe(
      true,
    );
  });

  it("drops a runtime the machine can't launch and a When that doesn't exist there", () => {
    const d = normalize(local({ ...EMPTY_DRAFT, runtime: "copilot", then: "waits-for-me" }));
    expect(d.runtime).toBe("claude-code");
    const pod = normalize({ ...EMPTY_DRAFT, then: "waits-for-me", when: "schedule" });
    expect(pod.when).toBe("manual");
  });

  it("keeps the local session mode in step with Then", () => {
    expect(
      normalize(local({ ...EMPTY_DRAFT, then: "waits-for-me" })).location.localSessionMode,
    ).toBe("interactive");
    expect(normalize(local(EMPTY_DRAFT)).location.localSessionMode).toBe("headless");
  });
});

suite("options", () => {
  it("offers a bare shell only for a terminal on a machine", () => {
    expect(
      runtimeOptions(local({ ...EMPTY_DRAFT, then: "waits-for-me" })).some(
        (r) => r.value === SHELL,
      ),
    ).toBe(true);
    expect(runtimeOptions(local(EMPTY_DRAFT)).some((r) => r.value === SHELL)).toBe(false);
    expect(runtimeOptions(EMPTY_DRAFT).some((r) => r.value === "copilot")).toBe(true);
    expect(runtimeOptions(local(EMPTY_DRAFT)).some((r) => r.value === "copilot")).toBe(false);
  });

  it("offers event triggers only on a machine, and nothing but 'now' for a pod terminal", () => {
    expect(whenOptions(local(EMPTY_DRAFT))).toContain("github");
    expect(whenOptions(EMPTY_DRAFT)).not.toContain("github");
    expect(whenOptions({ ...EMPTY_DRAFT, then: "waits-for-me" })).toEqual(["manual"]);
  });
});

suite("the sentence", () => {
  it("reads naturally for a PR task", () => {
    const d = { ...EMPTY_DRAFT, repoUrl: "https://github.com/acme/app" };
    expect(text(d, { repoName: "acme/app" })).toBe(
      "A Claude Code session in an Optio pod with acme/app that opens a PR and exits when done, started now.",
    );
  });

  it("names the machine and directory for a local terminal", () => {
    const d = normalize(
      local({ ...EMPTY_DRAFT, then: "waits-for-me", withRepo: false }, "/Users/dev/notes"),
    );
    expect(text(d, { machineName: "M1" })).toBe(
      "A Claude Code session on M1 in ~/notes that waits for you between turns, opened now.",
    );
  });

  it("describes schedules and marks what's missing", () => {
    const d = normalize({
      ...EMPTY_DRAFT,
      withRepo: false,
      when: "schedule",
      trigger: { type: "schedule", cronExpression: "0 9 * * 1-5" },
    });
    expect(text(d)).toBe(
      "A Claude Code session in an Optio pod that exits when done, running weekdays at 09:00 UTC.",
    );
    const missing = normalize({ ...EMPTY_DRAFT, then: "waits-for-messages" });
    expect(text(missing)).toContain("[a name]");
    expect(missingFields(missing)).toEqual(["slug", "title", "prompt"]);
  });

  it("does not demand a title or prompt for a terminal you open by hand", () => {
    expect(
      missingFields(normalize(local({ ...EMPTY_DRAFT, then: "waits-for-me", withRepo: false }))),
    ).toEqual([]);
    expect(
      missingFields(normalize({ ...EMPTY_DRAFT, then: "waits-for-me", repoUrl: "x" })),
    ).toEqual([]);
  });
});

suite("presets", () => {
  it("land on the kinds their labels promise", () => {
    const by = Object.fromEntries(PRESETS.map((p) => [p.id, normalize(p.apply(EMPTY_DRAFT))]));
    expect(deriveKind(by.pr)).toBe("repo-task");
    expect(deriveKind(local(by.chat))).toBe("local-terminal");
    expect(deriveKind(by.schedule)).toBe("standalone");
    expect(deriveKind(by.agent)).toBe("persistent-agent");
  });
});
