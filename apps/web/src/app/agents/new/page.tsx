"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Bot, ArrowLeft } from "lucide-react";

const RUNTIMES = ["claude-code", "codex", "copilot", "gemini", "opencode"] as const;
const LIFECYCLES = ["sticky", "always-on", "on-demand"] as const;

export default function NewAgentPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    slug: "",
    name: "",
    description: "",
    agentRuntime: "claude-code" as (typeof RUNTIMES)[number],
    model: "",
    systemPrompt: "",
    agentsMd: defaultAgentsMd(),
    initialPrompt: "",
    podLifecycle: "sticky" as (typeof LIFECYCLES)[number],
    idlePodTimeoutMs: 300_000,
    maxTurns: 50,
    maxTurnDurationMs: 600_000,
    consecutiveFailureLimit: 3,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.slug || !form.name || !form.initialPrompt) {
      toast.error("Slug, name, and initial prompt are required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.createPersistentAgent({
        slug: form.slug,
        name: form.name,
        description: form.description || undefined,
        agentRuntime: form.agentRuntime,
        model: form.model || null,
        systemPrompt: form.systemPrompt || null,
        agentsMd: form.agentsMd || null,
        initialPrompt: form.initialPrompt,
        podLifecycle: form.podLifecycle,
        idlePodTimeoutMs: form.idlePodTimeoutMs,
        maxTurns: form.maxTurns,
        maxTurnDurationMs: form.maxTurnDurationMs,
        consecutiveFailureLimit: form.consecutiveFailureLimit,
      });
      toast.success("Agent created");
      router.push(`/agents/${res.agent.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create failed";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20";

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Link
        href="/agents"
        className="text-sm text-text-muted hover:text-text flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Agents
      </Link>
      <h1 className="text-2xl font-semibold flex items-center gap-2">
        <Bot className="w-6 h-6 text-primary" />
        New persistent agent
      </h1>
      <p className="text-sm text-text-muted mt-1">
        A long-lived addressable agent. After creation, it auto-runs its initial mission and then
        idles, waiting for messages.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Slug" hint="Unique addressable name (a-z, 0-9, hyphens)">
            <input
              className={inputCls}
              required
              placeholder="vesper"
              pattern="[a-z0-9][a-z0-9-]*"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
            />
          </Field>
          <Field label="Name" hint="Display name shown in the UI">
            <input
              className={inputCls}
              required
              placeholder="Vesper the Architect"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
        </div>

        <Field label="Description" hint="Short summary of the agent's role">
          <input
            className={inputCls}
            placeholder="Decomposes feature requests into specs and dispatches them"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Runtime">
            <select
              className={inputCls}
              value={form.agentRuntime}
              onChange={(e) =>
                setForm({ ...form, agentRuntime: e.target.value as (typeof RUNTIMES)[number] })
              }
            >
              {RUNTIMES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model" hint="Optional override">
            <input
              className={inputCls}
              placeholder="(default for runtime)"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
          </Field>
          <Field label="Pod lifecycle">
            <select
              className={inputCls}
              value={form.podLifecycle}
              onChange={(e) =>
                setForm({ ...form, podLifecycle: e.target.value as (typeof LIFECYCLES)[number] })
              }
            >
              {LIFECYCLES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Idle pod TTL (ms)" hint="sticky mode only">
            <input
              type="number"
              className={inputCls}
              value={form.idlePodTimeoutMs}
              disabled={form.podLifecycle !== "sticky"}
              onChange={(e) => setForm({ ...form, idlePodTimeoutMs: Number(e.target.value) })}
            />
          </Field>
          <Field label="Max turn duration (ms)">
            <input
              type="number"
              className={inputCls}
              value={form.maxTurnDurationMs}
              onChange={(e) => setForm({ ...form, maxTurnDurationMs: Number(e.target.value) })}
            />
          </Field>
          <Field label="Failures before halt" hint="Consecutive failures → FAILED">
            <input
              type="number"
              min={1}
              className={inputCls}
              value={form.consecutiveFailureLimit}
              onChange={(e) =>
                setForm({ ...form, consecutiveFailureLimit: Number(e.target.value) })
              }
            />
          </Field>
        </div>

        <Field
          label="System prompt"
          hint="Persona — who is this agent? Stays constant across all turns."
        >
          <textarea
            className={inputCls + " min-h-[100px] font-mono text-xs"}
            placeholder="You are Vesper, the architect of the Forge…"
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
          />
        </Field>

        <Field
          label="Operator manual (agents.md)"
          hint="How to use the optio internal API. Shown to the agent every turn."
        >
          <textarea
            className={inputCls + " min-h-[180px] font-mono text-xs"}
            value={form.agentsMd}
            onChange={(e) => setForm({ ...form, agentsMd: e.target.value })}
          />
        </Field>

        <Field
          label="Initial prompt"
          hint="The agent's first mission — sent only on the first turn."
        >
          <textarea
            className={inputCls + " min-h-[100px] font-mono text-xs"}
            required
            placeholder="Wait for feature requests via messages, then break them into specs."
            value={form.initialPrompt}
            onChange={(e) => setForm({ ...form, initialPrompt: e.target.value })}
          />
        </Field>

        <div className="flex items-center justify-end gap-3 pt-2">
          <Link href="/agents" className="text-sm text-text-muted hover:text-text">
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create agent"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-sm font-medium text-text mb-1">{label}</div>
      {hint ? <div className="text-xs text-text-muted mb-1.5">{hint}</div> : null}
      {children}
    </label>
  );
}

function defaultAgentsMd(): string {
  return `You are running as a Persistent Agent inside Optio. You can talk to other
agents in this workspace through Optio's HTTP API. Use the bash + curl
verbs below — there is no human waiting at a terminal, so design every
call to be non-interactive.

Environment variables (already set):
- OPTIO_API_URL          — base URL for Optio's API
- OPTIO_AGENT_TOKEN      — your bearer token (your own UUID)
- OPTIO_PERSISTENT_AGENT_SLUG — your own slug
- OPTIO_PERSISTENT_AGENT_TURN_ID — current turn id

## List addressable agents in your workspace

    curl -s -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
      "$OPTIO_API_URL/api/internal/persistent-agents"

## Send a direct message to another agent (by slug)

    curl -s -X POST -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{"to":"forge","body":"Please implement spec X..."}' \\
      "$OPTIO_API_URL/api/internal/persistent-agents/send"

## Broadcast to everyone in your workspace

    curl -s -X POST -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{"body":"Heads up, the build is broken."}' \\
      "$OPTIO_API_URL/api/internal/persistent-agents/broadcast"

## Read your own recent inbox

    curl -s -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
      "$OPTIO_API_URL/api/internal/persistent-agents/inbox?limit=20"

## Inbox messages you receive

Messages from other agents arrive in your prompt as structured blocks:

    ---BEGIN OPTIO MESSAGE---
    {"version":1,"timestamp":"...","sender":"agent:.../forge","type":"instruction","broadcasted":false,"body":"..."}
    ---END OPTIO MESSAGE---

Always read these carefully — they are your inputs.

## Halt

When you have nothing more to do this turn, simply finish your response.
Optio will mark the turn complete and you'll be re-woken on the next
message, webhook, or scheduled tick.
`;
}
