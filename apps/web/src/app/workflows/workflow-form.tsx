"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { NumberInput } from "@/components/number-input";
import {
  Loader2,
  Save,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Zap,
  Clock,
  Globe,
} from "lucide-react";
import { toast } from "sonner";

// ── Types ───────────────────────────────────────────────────────────────────

interface WorkflowFormData {
  name: string;
  description: string;
  enabled: boolean;
  // Environment
  environmentSpec: string; // JSON string
  // Agent settings
  agentRuntime: string;
  model: string;
  maxTurns: number | null;
  budgetUsd: string;
  maxConcurrent: number;
  maxRetries: number;
  warmPoolSize: number;
  // Prompt
  promptTemplate: string;
  // Params
  paramsSchema: string; // JSON string
}

interface TriggerFormData {
  id?: string;
  type: "manual" | "schedule" | "webhook";
  config: string; // JSON string
  paramMapping: string; // JSON string
  enabled: boolean;
  _isNew?: boolean;
  _deleted?: boolean;
}

interface WorkflowFormProps {
  mode: "create" | "edit";
  workflowId?: string;
  initialData?: any;
  initialTriggers?: any[];
}

const AGENT_RUNTIMES = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "opencode", label: "OpenCode (Experimental)" },
  { value: "gemini", label: "Google Gemini" },
];

const TRIGGER_TYPES = [
  { value: "manual", label: "Manual", icon: Zap },
  { value: "schedule", label: "Schedule", icon: Clock },
  { value: "webhook", label: "Webhook", icon: Globe },
];

const INPUT_CLASS =
  "w-full px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors";

const DEFAULT_FORM: WorkflowFormData = {
  name: "",
  description: "",
  enabled: true,
  environmentSpec: "",
  agentRuntime: "claude-code",
  model: "",
  maxTurns: null,
  budgetUsd: "",
  maxConcurrent: 2,
  maxRetries: 1,
  warmPoolSize: 0,
  promptTemplate: "",
  paramsSchema: "",
};

// ── Param detection helper ──────────────────────────────────────────────────

function detectParams(promptTemplate: string): string[] {
  const matches = promptTemplate.match(/\{\{(\w+)\}\}/g);
  if (!matches) return [];
  const unique = [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, "")))];
  return unique;
}

function buildParamsSchemaFromPrompt(
  promptTemplate: string,
  existing: Record<string, unknown> | null,
): Record<string, unknown> {
  const detected = detectParams(promptTemplate);
  if (detected.length === 0) return existing ?? {};

  const properties: Record<string, unknown> = {};
  const existingProps = (existing as any)?.properties ?? {};

  for (const param of detected) {
    properties[param] = existingProps[param] ?? {
      type: "string",
      description: "",
    };
  }

  return {
    type: "object",
    properties,
    required: detected,
  };
}

// ── JSON helpers ────────────────────────────────────────────────────────────

function tryParseJson(str: string): Record<string, unknown> | null {
  if (!str.trim()) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function prettyJson(obj: unknown): string {
  if (!obj) return "";
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return "";
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export function WorkflowForm({
  mode,
  workflowId,
  initialData,
  initialTriggers,
}: WorkflowFormProps) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showEnvSpec, setShowEnvSpec] = useState(false);

  const [form, setForm] = useState<WorkflowFormData>(() => {
    if (initialData) {
      return {
        name: initialData.name ?? "",
        description: initialData.description ?? "",
        enabled: initialData.enabled ?? true,
        environmentSpec: prettyJson(initialData.environmentSpec),
        agentRuntime: initialData.agentRuntime ?? "claude-code",
        model: initialData.model ?? "",
        maxTurns: initialData.maxTurns ?? null,
        budgetUsd: initialData.budgetUsd ?? "",
        maxConcurrent: initialData.maxConcurrent ?? 2,
        maxRetries: initialData.maxRetries ?? 1,
        warmPoolSize: initialData.warmPoolSize ?? 0,
        promptTemplate: initialData.promptTemplate ?? "",
        paramsSchema: prettyJson(initialData.paramsSchema),
      };
    }
    return DEFAULT_FORM;
  });

  const [triggers, setTriggers] = useState<TriggerFormData[]>(() => {
    if (initialTriggers && initialTriggers.length > 0) {
      return initialTriggers.map((t: any) => ({
        id: t.id,
        type: t.type,
        config: prettyJson(t.config),
        paramMapping: prettyJson(t.paramMapping),
        enabled: t.enabled,
      }));
    }
    return [];
  });

  // Detect params from prompt template
  const detectedParams = useMemo(() => detectParams(form.promptTemplate), [form.promptTemplate]);

  // JSON validation state
  const [envSpecError, setEnvSpecError] = useState<string | null>(null);
  const [paramsSchemaError, setParamsSchemaError] = useState<string | null>(null);

  useEffect(() => {
    if (form.environmentSpec.trim()) {
      try {
        JSON.parse(form.environmentSpec);
        setEnvSpecError(null);
      } catch (e) {
        setEnvSpecError("Invalid JSON");
      }
    } else {
      setEnvSpecError(null);
    }
  }, [form.environmentSpec]);

  useEffect(() => {
    if (form.paramsSchema.trim()) {
      try {
        JSON.parse(form.paramsSchema);
        setParamsSchemaError(null);
      } catch (e) {
        setParamsSchemaError("Invalid JSON");
      }
    } else {
      setParamsSchemaError(null);
    }
  }, [form.paramsSchema]);

  // Auto-expand environment section if there's data
  useEffect(() => {
    if (form.environmentSpec.trim()) setShowEnvSpec(true);
  }, []);

  const handleAutoParams = useCallback(() => {
    const existing = tryParseJson(form.paramsSchema);
    const schema = buildParamsSchemaFromPrompt(form.promptTemplate, existing);
    setForm((f) => ({ ...f, paramsSchema: prettyJson(schema) }));
    toast.success(`Detected ${detectedParams.length} parameter(s)`);
  }, [form.promptTemplate, form.paramsSchema, detectedParams.length]);

  const addTrigger = () => {
    setTriggers((t) => [
      ...t,
      {
        type: "manual",
        config: "",
        paramMapping: "",
        enabled: true,
        _isNew: true,
      },
    ]);
  };

  const removeTrigger = (index: number) => {
    setTriggers((t) => {
      const trigger = t[index];
      if (trigger.id) {
        // Mark existing trigger for deletion
        return t.map((tr, i) => (i === index ? { ...tr, _deleted: true } : tr));
      }
      // Remove new trigger entirely
      return t.filter((_, i) => i !== index);
    });
  };

  const updateTrigger = (index: number, updates: Partial<TriggerFormData>) => {
    setTriggers((t) => t.map((tr, i) => (i === index ? { ...tr, ...updates } : tr)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!form.promptTemplate.trim()) {
      toast.error("Prompt template is required");
      return;
    }
    if (envSpecError || paramsSchemaError) {
      toast.error("Fix JSON errors before saving");
      return;
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        description: form.description || undefined,
        enabled: form.enabled,
        promptTemplate: form.promptTemplate,
        agentRuntime: form.agentRuntime,
        model: form.model || undefined,
        maxTurns: form.maxTurns || undefined,
        budgetUsd: form.budgetUsd || undefined,
        maxConcurrent: form.maxConcurrent,
        maxRetries: form.maxRetries,
        warmPoolSize: form.warmPoolSize,
        environmentSpec: tryParseJson(form.environmentSpec) ?? undefined,
        paramsSchema: tryParseJson(form.paramsSchema) ?? undefined,
      };

      let savedWorkflowId = workflowId;

      if (mode === "create") {
        const res = await api.createWorkflow(payload as any);
        savedWorkflowId = res.workflow.id;
        toast.success("Workflow created");
      } else {
        await api.updateWorkflow(savedWorkflowId!, payload);
        toast.success("Workflow updated");
      }

      // Save triggers
      for (const trigger of triggers) {
        if (trigger._deleted && trigger.id) {
          await api.deleteWorkflowTrigger(savedWorkflowId!, trigger.id);
        } else if (trigger._deleted) {
          continue;
        } else if (trigger._isNew || !trigger.id) {
          await api.createWorkflowTrigger(savedWorkflowId!, {
            type: trigger.type,
            config: tryParseJson(trigger.config) ?? undefined,
            paramMapping: tryParseJson(trigger.paramMapping) ?? undefined,
            enabled: trigger.enabled,
          });
        } else {
          await api.updateWorkflowTrigger(savedWorkflowId!, trigger.id, {
            type: trigger.type,
            config: tryParseJson(trigger.config),
            paramMapping: tryParseJson(trigger.paramMapping),
            enabled: trigger.enabled,
          });
        }
      }

      router.push("/workflows");
    } catch (err) {
      toast.error(`Failed to ${mode === "create" ? "create" : "update"} workflow`, {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const visibleTriggers = triggers.filter((t) => !t._deleted);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* ── Basics ──────────────────────────────────────────────────────── */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
        <div>
          <h2 className="text-sm font-medium mb-1">Basics</h2>
          <p className="text-xs text-text-muted">Name and description for this workflow.</p>
        </div>

        <div>
          <label className="block text-sm text-text-muted mb-1.5">Name</label>
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="deploy-to-staging"
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <label className="block text-sm text-text-muted mb-1.5">Description</label>
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Optional description of what this workflow does"
            className={INPUT_CLASS + " resize-y"}
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            className="rounded"
          />
          Enabled
        </label>
      </section>

      {/* ── Environment ─────────────────────────────────────────────────── */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
        <div>
          <button
            type="button"
            onClick={() => setShowEnvSpec(!showEnvSpec)}
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            {showEnvSpec ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            Environment
          </button>
          <p className="text-xs text-text-muted mt-0.5">
            Image preset, setup commands, secrets, and network configuration (JSON).
          </p>
        </div>

        {showEnvSpec && (
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Environment Spec (JSON)</label>
            <textarea
              rows={6}
              value={form.environmentSpec}
              onChange={(e) => setForm((f) => ({ ...f, environmentSpec: e.target.value }))}
              placeholder={`{\n  "image": "node",\n  "setupCommands": ["npm install"],\n  "secrets": ["DEPLOY_KEY"],\n  "networkAccess": true\n}`}
              className={`${INPUT_CLASS} font-mono text-xs resize-y ${envSpecError ? "border-error" : ""}`}
            />
            {envSpecError && (
              <p className="text-xs text-error mt-1 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {envSpecError}
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── Agent Settings ──────────────────────────────────────────────── */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
        <div>
          <h2 className="text-sm font-medium mb-1">Agent Settings</h2>
          <p className="text-xs text-text-muted">Runtime, model, and execution limits.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Agent Runtime</label>
            <select
              value={form.agentRuntime}
              onChange={(e) => setForm((f) => ({ ...f, agentRuntime: e.target.value }))}
              className={INPUT_CLASS}
            >
              {AGENT_RUNTIMES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Model</label>
            <input
              type="text"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="e.g., sonnet, opus"
              className={INPUT_CLASS}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Max Turns</label>
            <NumberInput
              min={1}
              max={200}
              value={form.maxTurns ?? ""}
              onChange={(v) => setForm((f) => ({ ...f, maxTurns: v }))}
              fallback={0}
              placeholder="Default"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Budget (USD)</label>
            <input
              type="text"
              value={form.budgetUsd}
              onChange={(e) => setForm((f) => ({ ...f, budgetUsd: e.target.value }))}
              placeholder="e.g., 5.00"
              className={INPUT_CLASS}
            />
          </div>
        </div>

        {/* Advanced execution settings */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text transition-colors"
        >
          {showAdvanced ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
          Advanced execution settings
        </button>

        {showAdvanced && (
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-text-muted mb-1.5">Max Concurrent</label>
              <NumberInput
                min={1}
                max={50}
                value={form.maxConcurrent}
                onChange={(v) => setForm((f) => ({ ...f, maxConcurrent: v }))}
                fallback={2}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1.5">Max Retries</label>
              <NumberInput
                min={0}
                max={10}
                value={form.maxRetries}
                onChange={(v) => setForm((f) => ({ ...f, maxRetries: v }))}
                fallback={1}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1.5">Warm Pool</label>
              <NumberInput
                min={0}
                max={10}
                value={form.warmPoolSize}
                onChange={(v) => setForm((f) => ({ ...f, warmPoolSize: v }))}
                fallback={0}
                className={INPUT_CLASS}
              />
            </div>
          </div>
        )}
      </section>

      {/* ── Prompt Template ─────────────────────────────────────────────── */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
        <div>
          <h2 className="text-sm font-medium mb-1">Prompt Template</h2>
          <p className="text-xs text-text-muted">
            Use {"{{PARAM_NAME}}"} syntax for parameters that will be filled at runtime.
          </p>
        </div>

        <div>
          <textarea
            required
            rows={8}
            value={form.promptTemplate}
            onChange={(e) => setForm((f) => ({ ...f, promptTemplate: e.target.value }))}
            placeholder={`Deploy {{REPO_NAME}} to {{ENVIRONMENT}}.\n\nSteps:\n1. Run tests\n2. Build artifacts\n3. Deploy to {{TARGET_HOST}}`}
            className={`${INPUT_CLASS} font-mono text-xs resize-y`}
          />
        </div>

        {detectedParams.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-text-muted">Detected parameters:</span>
            {detectedParams.map((p) => (
              <span
                key={p}
                className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-mono"
              >
                {p}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── Parameters Schema ───────────────────────────────────────────── */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium mb-1">Parameters Schema</h2>
            <p className="text-xs text-text-muted">
              JSON Schema defining input parameters for this workflow.
            </p>
          </div>
          {detectedParams.length > 0 && (
            <button
              type="button"
              onClick={handleAutoParams}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
            >
              <Zap className="w-3 h-3" />
              Auto-detect from prompt
            </button>
          )}
        </div>

        <div>
          <textarea
            rows={6}
            value={form.paramsSchema}
            onChange={(e) => setForm((f) => ({ ...f, paramsSchema: e.target.value }))}
            placeholder={`{\n  "type": "object",\n  "properties": {\n    "REPO_NAME": { "type": "string", "description": "Repository name" }\n  },\n  "required": ["REPO_NAME"]\n}`}
            className={`${INPUT_CLASS} font-mono text-xs resize-y ${paramsSchemaError ? "border-error" : ""}`}
          />
          {paramsSchemaError && (
            <p className="text-xs text-error mt-1 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {paramsSchemaError}
            </p>
          )}
        </div>
      </section>

      {/* ── Triggers ────────────────────────────────────────────────────── */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium mb-1">Triggers</h2>
            <p className="text-xs text-text-muted">
              How this workflow gets started: manually, on a schedule, or via webhook.
            </p>
          </div>
          <button
            type="button"
            onClick={addTrigger}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg-hover text-text-muted text-xs font-medium hover:text-text transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Trigger
          </button>
        </div>

        {visibleTriggers.length === 0 && (
          <p className="text-xs text-text-muted/60 py-2">
            No triggers configured. Add a trigger to automate workflow execution.
          </p>
        )}

        {triggers.map((trigger, index) => {
          if (trigger._deleted) return null;
          const TriggerIcon = TRIGGER_TYPES.find((t) => t.value === trigger.type)?.icon ?? Zap;

          return (
            <div
              key={trigger.id ?? `new-${index}`}
              className="p-4 rounded-lg border border-border/50 bg-bg space-y-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TriggerIcon className="w-4 h-4 text-text-muted" />
                  <select
                    value={trigger.type}
                    onChange={(e) =>
                      updateTrigger(index, { type: e.target.value as TriggerFormData["type"] })
                    }
                    className="px-2 py-1 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                  >
                    {TRIGGER_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={trigger.enabled}
                      onChange={(e) => updateTrigger(index, { enabled: e.target.checked })}
                      className="rounded"
                    />
                    Enabled
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => removeTrigger(index)}
                  className="p-1 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {trigger.type === "schedule" && (
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Cron Expression (in config JSON)
                  </label>
                  <textarea
                    rows={2}
                    value={trigger.config}
                    onChange={(e) => updateTrigger(index, { config: e.target.value })}
                    placeholder={`{"cronExpression": "0 9 * * 1-5"}`}
                    className={`${INPUT_CLASS} font-mono text-xs`}
                  />
                </div>
              )}

              {trigger.type === "webhook" && (
                <div>
                  <label className="block text-xs text-text-muted mb-1">
                    Webhook Config (JSON)
                  </label>
                  <textarea
                    rows={2}
                    value={trigger.config}
                    onChange={(e) => updateTrigger(index, { config: e.target.value })}
                    placeholder={`{"secret": "...", "filter": {"event": "push"}}`}
                    className={`${INPUT_CLASS} font-mono text-xs`}
                  />
                </div>
              )}

              {trigger.type === "manual" && (
                <p className="text-xs text-text-muted/60">
                  Manual triggers are started by a user action. No additional configuration needed.
                </p>
              )}

              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Param Mapping (JSON, optional)
                </label>
                <textarea
                  rows={2}
                  value={trigger.paramMapping}
                  onChange={(e) => updateTrigger(index, { paramMapping: e.target.value })}
                  placeholder={`{"REPO_NAME": "$.repository.name"}`}
                  className={`${INPUT_CLASS} font-mono text-xs`}
                />
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Submit ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2.5 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? "Saving..." : mode === "create" ? "Create Workflow" : "Save Changes"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/workflows")}
          className="px-4 py-2.5 rounded-md bg-bg-card border border-border text-text-muted text-sm font-medium hover:text-text hover:bg-bg-hover transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
