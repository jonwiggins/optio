"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Bot, Check, Copy, Download, Loader2 } from "lucide-react";
import { api, type ApiKeyCreated } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SectionCard } from "@/components/ui/section-card";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { cliServerUrl, isLoopbackUrl } from "@/components/local/pair-machine";

/**
 * Settings → Access → "Connect your agent": the Claude Code (or OpenCode,
 * or any stdio-only client) on somebody's own laptop talking to Optio
 * through the controller MCP at /api/mcp (docs/controller-mcp.md, "Connect
 * your own agent"). One click mints a personal access token named after
 * the client, and the command and config snippets below fill in with it
 * while it is on screen; afterwards they show a placeholder, since a token
 * is shown once.
 *
 * The URL is the API as this browser reaches it (`cliServerUrl`, the
 * `PUBLIC_API_URL` the layout injects, else this page's origin, whose
 * `/api/mcp` the web proxy passes through).
 */

export type AgentClient = "claude-code" | "opencode" | "stdio";

const CLIENTS: Array<{ value: AgentClient; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "stdio", label: "Other (stdio)" },
];

const CLIENT_NAMES: Record<AgentClient, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  stdio: "stdio bridge",
};

export const TOKEN_PLACEHOLDER = "optio_pat_REPLACE_ME";

/** The MCP endpoint of the API at `server`. */
export function mcpUrl(server: string): string {
  return `${server.replace(/\/+$/, "")}/api/mcp`;
}

/** The headers every client sends: the token, and the workspace when known. */
function headers(token: string, workspaceId: string | null | undefined): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
  };
}

/** `claude mcp add --transport http optio <url> --header "Authorization: Bearer <pat>"`. */
export function claudeAddCommand(
  server: string,
  token: string,
  workspaceId?: string | null,
): string {
  const flags = Object.entries(headers(token, workspaceId))
    .map(([k, v]) => `--header "${k}: ${v}"`)
    .join(" ");
  return `claude mcp add --transport http optio ${mcpUrl(server)} ${flags}`;
}

/** Claude Code's `.mcp.json` / `~/.claude.json` entry. */
export function claudeSettingsSnippet(
  server: string,
  token: string,
  workspaceId?: string | null,
): string {
  return JSON.stringify(
    {
      mcpServers: {
        optio: { type: "http", url: mcpUrl(server), headers: headers(token, workspaceId) },
      },
    },
    null,
    2,
  );
}

/** OpenCode's `opencode.json` entry. */
export function opencodeSnippet(
  server: string,
  token: string,
  workspaceId?: string | null,
): string {
  return JSON.stringify(
    {
      mcp: {
        optio: {
          type: "remote",
          url: mcpUrl(server),
          headers: headers(token, workspaceId),
          enabled: true,
        },
      },
    },
    null,
    2,
  );
}

/** The stdio adapter's entry: `node optio-controller-mcp.js` with the env it reads. */
export function stdioSnippet(server: string, token: string, workspaceId?: string | null): string {
  return JSON.stringify(
    {
      mcpServers: {
        optio: {
          command: "node",
          args: ["/path/to/optio-controller-mcp.js"],
          env: {
            OPTIO_MCP_URL: mcpUrl(server),
            OPTIO_MCP_TOKEN: token,
            ...(workspaceId ? { OPTIO_WORKSPACE_ID: workspaceId } : {}),
          },
        },
      },
    },
    null,
    2,
  );
}

function Snippet({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed — select the text and copy it manually");
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{label}</p>
        <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="rounded bg-bg border border-border px-2 py-1.5 text-xs font-mono whitespace-pre-wrap break-all select-all"
      >
        {value}
      </pre>
    </div>
  );
}

export function ConnectYourAgent() {
  const { user, authDisabled } = useCurrentUser();
  const [client, setClient] = useState<AgentClient>("claude-code");
  const [server, setServer] = useState("");
  const [minting, setMinting] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  useEffect(() => {
    setServer(cliServerUrl());
  }, []);

  const workspaceId = user?.workspaceId ?? null;
  const token = created?.token ?? (authDisabled ? "dev" : TOKEN_PLACEHOLDER);
  const loopback = !!server && isLoopbackUrl(server);

  async function mint() {
    setMinting(true);
    try {
      const res = await api.createApiKey({ name: `MCP: ${CLIENT_NAMES[client]}` });
      setCreated(res);
      toast.success("Token created — it is filled into the snippets below, once");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setMinting(false);
    }
  }

  return (
    <SectionCard
      label="Connect your agent"
      hint="Let the Claude Code on your laptop create and run work in Optio"
      summary={created ? "token ready" : undefined}
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        Optio serves an MCP server at <code className="px-1 rounded bg-bg">{mcpUrl(server)}</code>.
        An agent connected to it can create work — on a schedule, on a webhook, or right now — run
        it, read its runs and logs, manage triggers and prompts, and message the agents Optio runs,
        with your workspace permissions. Viewers get the read tools only.
      </p>

      {loopback && (
        <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs">
          This page reaches the API at a localhost address, which another computer cannot use. Set{" "}
          <code className="px-1 rounded bg-bg">PUBLIC_API_URL</code> (or{" "}
          <code className="px-1 rounded bg-bg">publicUrl</code> in the chart) to the address people
          reach Optio at, then come back here.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={client}
          onChange={(v) => setClient(v as AgentClient)}
          options={CLIENTS}
          aria-label="Client"
        />
        {!authDisabled && (
          <Button type="button" onClick={mint} disabled={minting} data-testid="mint-token">
            {minting ? <Loader2 className="animate-spin" /> : <Bot />}
            {created ? "Create another token" : "Create a token for this agent"}
          </Button>
        )}
      </div>

      {created ? (
        <p className="text-xs text-text-muted" data-testid="token-note">
          Token “{created.name}” is filled in below. Copy what you need now: it is not shown again,
          and it can be revoked under API keys.
        </p>
      ) : authDisabled ? (
        <p className="text-xs text-text-muted">
          Authentication is off on this deployment, so any bearer value works; the snippets use{" "}
          <code className="px-1 rounded bg-bg">dev</code>.
        </p>
      ) : (
        <p className="text-xs text-text-muted">
          Create a token, or replace <code className="px-1 rounded bg-bg">{TOKEN_PLACEHOLDER}</code>{" "}
          with one from API keys.
        </p>
      )}

      {client === "claude-code" && (
        <>
          <Snippet
            label="Terminal"
            value={claudeAddCommand(server, token, workspaceId)}
            testId="snippet-command"
          />
          <Snippet
            label="Or in ~/.claude.json / .mcp.json"
            value={claudeSettingsSnippet(server, token, workspaceId)}
            testId="snippet-config"
          />
        </>
      )}
      {client === "opencode" && (
        <Snippet
          label="opencode.json"
          value={opencodeSnippet(server, token, workspaceId)}
          testId="snippet-config"
        />
      )}
      {client === "stdio" && (
        <>
          <p className="text-xs text-text-muted">
            For a client that speaks stdio only: download the adapter (one file, Node 20 or newer),
            and point the client at it. It relays every tool to{" "}
            <code className="px-1 rounded bg-bg">/api/mcp</code>.
          </p>
          <a
            href={api.controllerMcpDownloadUrl()}
            download="optio-controller-mcp.js"
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            data-testid="download-bridge"
          >
            <Download className="w-3.5 h-3.5" />
            Download optio-controller-mcp.js
          </a>
          <Snippet
            label="MCP client config"
            value={stdioSnippet(server, token, workspaceId)}
            testId="snippet-config"
          />
        </>
      )}

      <p className="text-[11px] text-text-muted/80">
        The agent must reach this URL from where it runs, so a laptop has to be on your network. For
        agents Optio runs itself, switch on Optio controller under Work → Environment instead.
      </p>
    </SectionCard>
  );
}
