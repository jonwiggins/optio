"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { api, type EnvironmentMirrors } from "@/lib/api-client";

/**
 * The note under an MCP server form when its command or install command
 * would reach for a package registry the agent pods don't have: an `npx`,
 * `pip` or `uvx` in a pod with no internet access only works through the
 * mirror named in `agent.env` (docs/air-gapped.md). The answer comes from
 * `GET /api/environment/mirrors` once per page; the match is a heuristic on
 * the typed command, no request per keystroke.
 */

type Mirror = keyof EnvironmentMirrors;

const TOOLS: Array<{ mirror: Mirror; pattern: RegExp; variable: string; registry: string }> = [
  {
    mirror: "npm",
    pattern: /(^|[\s;&|])(npx|npm|pnpm|yarn)(\s|$)/,
    variable: "NPM_CONFIG_REGISTRY",
    registry: "npm",
  },
  {
    mirror: "pip",
    pattern: /(^|[\s;&|])(pip3?|pipx|python3?\s+-m\s+pip)(\s|$)/,
    variable: "PIP_INDEX_URL",
    registry: "PyPI",
  },
  {
    mirror: "uv",
    pattern: /(^|[\s;&|])(uvx|uv)(\s|$)/,
    variable: "UV_DEFAULT_INDEX",
    registry: "PyPI (uv)",
  },
];

/** The mirrors `command` and `installCommand` would need, in the order they appear. */
export function mirrorsNeeded(...commands: Array<string | null | undefined>): Mirror[] {
  const text = commands.map((c) => (c ?? "").trim()).filter(Boolean);
  const out: Mirror[] = [];
  for (const tool of TOOLS) {
    if (text.some((t) => tool.pattern.test(t))) out.push(tool.mirror);
  }
  return out;
}

/** "needs the npm mirror (Artifactory) — set agent.env.NPM_CONFIG_REGISTRY". */
export function mirrorMessage(mirror: Mirror): string {
  const tool = TOOLS.find((t) => t.mirror === mirror)!;
  return `needs the ${tool.registry} mirror (Artifactory) — set agent.env.${tool.variable}`;
}

let cached: Promise<EnvironmentMirrors | null> | null = null;

/** The deployment's mirrors, fetched once per page load; null when the API can't say. */
function loadMirrors(): Promise<EnvironmentMirrors | null> {
  if (!cached) {
    cached = Promise.resolve()
      .then(() => api.getEnvironmentMirrors())
      .catch(() => null);
  }
  return cached;
}

/** Forget the cached answer (tests). */
export function _resetMirrors(): void {
  cached = null;
}

export function MirrorWarning({
  command,
  installCommand,
  className,
}: {
  command?: string | null;
  installCommand?: string | null;
  className?: string;
}) {
  const [mirrors, setMirrors] = useState<EnvironmentMirrors | null>(null);
  useEffect(() => {
    let live = true;
    void loadMirrors().then((m) => {
      if (live) setMirrors(m);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!mirrors) return null;
  const missing = mirrorsNeeded(command, installCommand).filter((m) => !mirrors[m]);
  if (missing.length === 0) return null;

  return (
    <div
      role="note"
      className={`flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning ${className ?? ""}`}
    >
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div className="space-y-0.5">
        {missing.map((m) => (
          <p key={m}>
            This server {mirrorMessage(m)}. Without it the install fails in a pod with no internet
            access; bake the server into the image or vendor it into the repo instead.
          </p>
        ))}
      </div>
    </div>
  );
}
