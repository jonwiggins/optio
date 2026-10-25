import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistantPlacement,
  assistantRuntimes,
  harnessInstalled,
  inPodTurnLimit,
  placeAssistantTurn,
  resetHarnessLookup,
} from "./assistant-placement.js";

const dirs: string[] = [];
afterEach(() => {
  resetHarnessLookup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A PATH holding only the named binaries. */
function pathWith(...bins: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "optio-harness-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  for (const bin of bins) {
    writeFileSync(join(dir, bin), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, bin), 0o755);
  }
  return dir;
}

describe("assistant placement", () => {
  it("defaults to the API pod inside Kubernetes only", () => {
    expect(assistantPlacement({ KUBERNETES_SERVICE_HOST: "10.0.0.1" })).toBe("api-pod");
    expect(assistantPlacement({})).toBe("agent-pod");
    expect(assistantPlacement({ KUBERNETES_SERVICE_HOST: "10.0.0.1", OPTIO_RUNTIME: "fake" })).toBe(
      "agent-pod",
    );
    expect(
      assistantPlacement({ OPTIO_RUNTIME: "fake", OPTIO_ASSISTANT_PLACEMENT: "api-pod" }),
    ).toBe("api-pod");
    expect(assistantPlacement({ OPTIO_ASSISTANT_PLACEMENT: "agent-pod" })).toBe("agent-pod");
    expect(assistantPlacement({ OPTIO_ASSISTANT_PLACEMENT: "garbage" })).toBe("agent-pod");
  });

  it("reads the in-pod turn limit with a sane default", () => {
    expect(inPodTurnLimit({})).toBe(3);
    expect(inPodTurnLimit({ OPTIO_ASSISTANT_IN_POD_MAX: "5" })).toBe(5);
    expect(inPodTurnLimit({ OPTIO_ASSISTANT_IN_POD_MAX: "0" })).toBe(3);
    expect(inPodTurnLimit({ OPTIO_ASSISTANT_IN_POD_MAX: "lots" })).toBe(3);
  });

  it("finds a harness's binary on PATH", () => {
    const env = { PATH: pathWith("claude") };
    expect(harnessInstalled("claude-code", env)).toBe(true);
    expect(harnessInstalled("codex", env)).toBe(false);
    expect(harnessInstalled("not-a-harness", env)).toBe(false);
  });

  it("places a turn: API pod when it can, an agent pod and why when it can't", () => {
    const env = { PATH: pathWith("claude"), KUBERNETES_SERVICE_HOST: "10.0.0.1" };
    const base = { runtime: "claude-code", assistant: true, repoUrl: null, liveInPod: 0 };
    expect(placeAssistantTurn(base, env)).toEqual({ where: "api-pod" });
    expect(placeAssistantTurn({ ...base, assistant: false }, env)).toEqual({
      where: "agent-pod",
      reason: "configured",
    });
    expect(placeAssistantTurn(base, { ...env, OPTIO_ASSISTANT_PLACEMENT: "agent-pod" })).toEqual({
      where: "agent-pod",
      reason: "configured",
    });
    expect(placeAssistantTurn({ ...base, repoUrl: "https://github.com/a/b" }, env)).toEqual({
      where: "agent-pod",
      reason: "repo",
    });
    expect(placeAssistantTurn({ ...base, runtime: "gemini" }, env)).toEqual({
      where: "agent-pod",
      reason: "harness-missing",
    });
    expect(placeAssistantTurn({ ...base, liveInPod: 3 }, env)).toEqual({
      where: "agent-pod",
      reason: "pod-full",
    });
    expect(
      placeAssistantTurn({ ...base, liveInPod: 3 }, { ...env, OPTIO_ASSISTANT_IN_POD_MAX: "4" }),
    ).toEqual({
      where: "api-pod",
    });
  });
});

describe("assistant harnesses and OPTIO_RUNTIMES", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers only the listed runtimes, and never runs another in the API pod", () => {
    vi.stubEnv("OPTIO_RUNTIMES", "claude-code,opencode");
    expect(assistantRuntimes()).toEqual(["claude-code", "opencode"]);
    // Dockerfile.api installs Codex; a deployment that leaves it out still doesn't run it.
    const env = { PATH: pathWith("claude", "codex"), KUBERNETES_SERVICE_HOST: "10.0.0.1" };
    expect(harnessInstalled("claude-code", env)).toBe(true);
    expect(harnessInstalled("codex", env)).toBe(false);
  });

  it("offers every harness by default", () => {
    expect(assistantRuntimes()).toEqual([
      "claude-code",
      "codex",
      "copilot",
      "gemini",
      "opencode",
      "cursor",
    ]);
    expect(harnessInstalled("codex", { PATH: pathWith("codex") })).toBe(true);
  });
});
