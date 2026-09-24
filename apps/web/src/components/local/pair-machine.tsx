"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, CheckCircle2, Copy, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { getWsBaseUrl } from "@/lib/ws-client";

/**
 * How to pair a computer with Optio Local: the steps, with the commands for
 * this server filled in — the CLI's `--server` is the API as this page
 * reaches it, and signing in is skipped when auth is off. Shown by "Add
 * machine" on the Machines page and in the New work form when "My machine"
 * has none yet. It watches the host list and says so when a machine
 * connects.
 */

/** The URL to hand `optio --server`: the API, as the browser reaches it. */
export function cliServerUrl(): string {
  if (typeof window === "undefined") return "";
  return getWsBaseUrl().replace(/^ws(s?):/, "http$1:");
}

/** A server URL another computer can't use as written. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** The commands for each step, given the server and whether sign-in is on. */
export function pairingCommands(server: string, authDisabled: boolean) {
  return {
    build: [
      "git clone https://github.com/jonwiggins/optio.git ~/optio && cd ~/optio",
      'pnpm install --filter "@optio/cli..." && pnpm --filter @optio/cli build',
      'alias optio="node ~/optio/apps/cli/dist/optio.js"',
    ],
    login: authDisabled ? null : [`optio login --server ${server}`],
    up: [authDisabled ? `optio --server ${server} local up` : "optio local up"],
  };
}

export function PairMachineGuide({
  hosts,
  loading,
  compact = false,
  className,
}: {
  hosts: any[];
  loading: boolean;
  /** Inside the New work form: fewer words. */
  compact?: boolean;
  className?: string;
}) {
  const [authDisabled, setAuthDisabled] = useState<boolean | null>(null);
  const [server, setServer] = useState("");

  useEffect(() => {
    setServer(cliServerUrl());
    api
      .getAuthProviders()
      .then((res) => setAuthDisabled(res.authDisabled))
      .catch(() => setAuthDisabled(false));
  }, []);

  // Machines online when the guide first saw the list; one that comes online
  // after that is the one being paired.
  const onlineAtStart = useRef<Set<string> | null>(null);
  if (onlineAtStart.current === null && !loading) {
    onlineAtStart.current = new Set(hosts.filter((h) => h.state === "online").map((h) => h.id));
  }
  const paired = onlineAtStart.current
    ? hosts.find((h) => h.state === "online" && !onlineAtStart.current!.has(h.id))
    : undefined;

  const cmds = pairingCommands(server || "<server>", authDisabled === true);
  let step = 0;

  return (
    <div className={cn("space-y-3 text-sm", className)}>
      {!compact && (
        <p className="text-xs text-text-muted leading-relaxed">
          The Optio CLI runs a small daemon on the computer. It connects out to Optio — nothing on
          the computer listens for connections — and runs work only in the directories you add.
        </p>
      )}

      <Step n={++step} title="Build the CLI" note="It isn't on npm yet. Needs Node 20+ and pnpm.">
        <CommandBlock lines={cmds.build} />
        {!compact && (
          <p className="text-[11px] text-text-muted/80 mt-1.5">
            Already have a checkout? Run the last two lines in it, with its path in the alias. Put
            the alias in your shell profile to keep it.
          </p>
        )}
      </Step>

      {cmds.login && (
        <Step n={++step} title="Sign in to this server" note="Opens a browser to finish.">
          <CommandBlock lines={cmds.login} />
        </Step>
      )}

      <Step
        n={++step}
        title="Start the daemon"
        note="Leave it running; it reconnects on its own after sleep or a network change."
      >
        <CommandBlock lines={cmds.up} />
        {cmds.login && (
          <p className="text-[11px] text-text-muted/80 mt-1.5">
            No browser there? Create a key under{" "}
            <Link href="/settings" className="text-primary hover:underline">
              Settings → API Keys
            </Link>{" "}
            and run{" "}
            <code className="font-mono">
              OPTIO_TOKEN=&lt;key&gt; optio --server {server || "<server>"} local up
            </code>{" "}
            instead of signing in.
          </p>
        )}
      </Step>

      {server && isLoopbackUrl(server) && (
        <p className="text-[11px] text-warning">
          <code className="font-mono">{new URL(server).host}</code> only reaches Optio from the
          computer it runs on. From another one, use an address that computer can reach.
        </p>
      )}

      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-md border text-xs",
          paired
            ? "border-success/30 bg-success/5 text-success"
            : "border-border bg-bg-card/60 text-text-muted",
        )}
        aria-live="polite"
      >
        {paired ? (
          <>
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>
              <span className="font-medium">{paired.name}</span> is connected
              {(paired.dirs ?? []).length === 0
                ? " — now add the directories it may work in."
                : "."}
            </span>
          </>
        ) : (
          <>
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
            <span>Waiting for a machine to connect…</span>
          </>
        )}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  note,
  children,
}: {
  n: number;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="w-5 h-5 shrink-0 rounded-full bg-primary/10 text-primary text-[11px] font-medium grid place-items-center mt-0.5">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text">
          {title}
          {note && <span className="text-xs text-text-muted"> — {note}</span>}
        </p>
        <div className="mt-1.5">{children}</div>
      </div>
    </div>
  );
}

/** A copyable shell snippet. */
export function CommandBlock({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select the text instead");
    }
  };
  return (
    <div className="relative rounded-md border border-border bg-bg">
      <pre className="px-3 py-2 pr-9 font-mono text-[12px] leading-relaxed text-text overflow-x-auto whitespace-pre">
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy command"}
        className="absolute top-1.5 right-1.5 p-1 rounded text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
