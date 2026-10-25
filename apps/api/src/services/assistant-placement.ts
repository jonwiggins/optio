/**
 * Where an Ask Optio turn runs.
 *
 * By default in the API pod itself, as a child process of this server
 * (`OPTIO_ASSISTANT_PLACEMENT=api-pod`, the process runtime): the assistant
 * is a short, chatty turn that only talks to Optio's own controller MCP, so
 * an agent pod of its own is a pod's worth of memory and scheduling for
 * nothing. `agent-pod` keeps the pooled agent pod per conversation for
 * deployments that want the assistant isolated from the API (its own
 * resources, no harness in the API image).
 *
 * A turn falls back to an agent pod when the API pod can't take it: the
 * harness isn't installed in the API image (every image has Claude Code and
 * Codex; a Copilot / Gemini / OpenCode / Cursor assistant runs in a pod),
 * the session has a repo (checkouts live in pods), or as many turns as the
 * pod allows are already running (`OPTIO_ASSISTANT_IN_POD_MAX`, default 3).
 * Unset, it is `api-pod` only inside Kubernetes: an API on a developer's
 * machine, or a test, must never run that machine's real `claude` as its
 * child unless told to.
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { featureFilter } from "@optio/shared";

export type AssistantPlacement = "api-pod" | "agent-pod";

/** The binary each harness is launched through (`buildPooledAgentCommand`). */
export const HARNESS_BINARIES: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  copilot: "copilot",
  gemini: "gemini",
  opencode: "opencode",
  cursor: "cursor-agent",
};

/** The harnesses Ask Optio is offered on: the deployment's runtimes (OPTIO_RUNTIMES). */
export function assistantRuntimes(): string[] {
  return featureFilter("runtimes", Object.keys(HARNESS_BINARIES));
}

/**
 * Unset, the placement is `api-pod` inside Kubernetes (the chart sets it
 * explicitly anyway) and `agent-pod` anywhere else: an API on a developer's
 * machine, or a test, must never pick up the `claude` on that machine's
 * PATH and run it as its own child.
 */
export function assistantPlacement(env: NodeJS.ProcessEnv = process.env): AssistantPlacement {
  const raw = env.OPTIO_ASSISTANT_PLACEMENT?.trim();
  if (raw === "api-pod" || raw === "agent-pod") return raw;
  return env.KUBERNETES_SERVICE_HOST && env.OPTIO_RUNTIME !== "fake" ? "api-pod" : "agent-pod";
}

/** How many assistant turns the API pod runs at once before the rest go to agent pods. */
export function inPodTurnLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.OPTIO_ASSISTANT_IN_POD_MAX ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

const installed = new Map<string, boolean>();

/** Whether the harness's binary is on this process's PATH (cached per binary). */
export function harnessInstalled(runtime: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = HARNESS_BINARIES[runtime];
  // A harness the deployment leaves out never runs in this pod, even if installed.
  if (!bin || !assistantRuntimes().includes(runtime)) return false;
  const key = `${bin}:${env.PATH ?? ""}`;
  const cached = installed.get(key);
  if (cached !== undefined) return cached;
  const found = (env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  installed.set(key, found);
  return found;
}

/** Forget what was found on PATH (tests). */
export function resetHarnessLookup(): void {
  installed.clear();
}

export type TurnPlacement =
  | { where: "api-pod" }
  | { where: "agent-pod"; reason: "configured" | "repo" | "harness-missing" | "pod-full" };

/** Where this turn runs, given what the session is and what the pod is doing. */
export function placeAssistantTurn(
  input: { runtime: string; assistant: boolean; repoUrl: string | null; liveInPod: number },
  env: NodeJS.ProcessEnv = process.env,
): TurnPlacement {
  if (!input.assistant || assistantPlacement(env) !== "api-pod")
    return { where: "agent-pod", reason: "configured" };
  if (input.repoUrl) return { where: "agent-pod", reason: "repo" };
  if (!harnessInstalled(input.runtime, env))
    return { where: "agent-pod", reason: "harness-missing" };
  if (input.liveInPod >= inPodTurnLimit(env)) return { where: "agent-pod", reason: "pod-full" };
  return { where: "api-pod" };
}
