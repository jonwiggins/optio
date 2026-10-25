import {
  MODEL_PROVIDER_MODEL_ROLES,
  isValidGatewayUrl,
  modelGatewayTypeInfo,
  normalizeGatewayBaseUrl,
  type ModelGatewayType,
  type ModelProvider,
  type ModelProviderModel,
  type ModelProviderModelRole,
  type ModelProviderPrices,
} from "@optio/shared";

/**
 * The gateway half of Settings → Model gateway (docs/model-gateway.md): the
 * catalog rows as the editable table holds them, their validation, and the
 * labels the list and the pickers show. The Bedrock half stays in
 * model-provider-form.ts, which branches on the form's `kind`.
 */

/** The effort levels Claude Code takes, in the table's order. */
export const GATEWAY_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const ROLE_LABELS: Record<ModelProviderModelRole, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

export const PRICE_KEYS: ReadonlyArray<keyof ModelProviderPrices> = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
];

export const PRICE_LABELS: Record<keyof ModelProviderPrices, string> = {
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
};

export const DEFAULT_GATEWAY_NAME = "Model gateway";

/** A new catalog row: every effort, default high, nothing else known yet. */
export function emptyGatewayModel(): ModelProviderModel {
  return { id: "", efforts: [...GATEWAY_EFFORTS], defaultEffort: "high" };
}

/** Check / uncheck an effort; a default effort that goes keeps the row sane. */
export function withEffort(m: ModelProviderModel, effort: string, on: boolean): ModelProviderModel {
  const efforts = GATEWAY_EFFORTS.filter((e) => (e === effort ? on : m.efforts?.includes(e)));
  const defaultEffort =
    m.defaultEffort && efforts.includes(m.defaultEffort) ? m.defaultEffort : efforts[0];
  return { ...m, efforts, ...(defaultEffort ? { defaultEffort } : { defaultEffort: undefined }) };
}

/** Which of Claude Code's aliases a row stands in for; "" for none. */
export function withRole(m: ModelProviderModel, role: string): ModelProviderModel {
  const next = { ...m };
  if (role && (MODEL_PROVIDER_MODEL_ROLES as readonly string[]).includes(role)) {
    next.role = role as ModelProviderModelRole;
  } else {
    delete next.role;
  }
  return next;
}

/** A number field's text as the row's value: blank clears it. */
export function parseNumber(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function withPrice(
  m: ModelProviderModel,
  key: keyof ModelProviderPrices,
  text: string,
): ModelProviderModel {
  const prices: ModelProviderPrices = { ...(m.prices ?? {}) };
  const n = parseNumber(text);
  if (n === undefined) delete prices[key];
  else prices[key] = n;
  return { ...m, ...(Object.keys(prices).length ? { prices } : { prices: undefined }) };
}

/** The rows as the API takes them: trimmed, blank fields dropped. */
export function cleanGatewayModels(models: ModelProviderModel[]): ModelProviderModel[] {
  return models
    .map((m) => {
      const out: ModelProviderModel = { id: m.id.trim() };
      if (m.label?.trim()) out.label = m.label.trim();
      if (m.contextWindow && m.contextWindow > 0) out.contextWindow = Math.floor(m.contextWindow);
      if (m.maxOutputTokens && m.maxOutputTokens > 0) {
        out.maxOutputTokens = Math.floor(m.maxOutputTokens);
      }
      if (m.efforts) out.efforts = m.efforts.filter((e) => GATEWAY_EFFORTS.includes(e));
      if (m.defaultEffort && out.efforts?.includes(m.defaultEffort)) {
        out.defaultEffort = m.defaultEffort;
      }
      if (m.prices && Object.values(m.prices).some((v) => typeof v === "number")) {
        out.prices = Object.fromEntries(
          Object.entries(m.prices).filter(([, v]) => typeof v === "number"),
        ) as ModelProviderPrices;
      }
      if (m.role) out.role = m.role;
      if (m.missing) out.missing = true;
      return out;
    })
    .filter((m) => m.id);
}

/** What's wrong with a catalog, or null. */
export function validateGatewayModels(models: ModelProviderModel[]): string | null {
  const ids = new Set<string>();
  for (const m of models) {
    const id = m.id.trim();
    if (!id) return "Every model needs an id (what the gateway calls it).";
    if (ids.has(id)) return `${id} is listed twice.`;
    ids.add(id);
    if (m.defaultEffort && m.efforts && !m.efforts.includes(m.defaultEffort)) {
      return `${id}: the default effort must be one it takes.`;
    }
  }
  return null;
}

/** What's wrong with the gateway's own fields, or null. */
export function validateGatewayFields(f: {
  gatewayType?: ModelGatewayType;
  baseUrl: string;
  syncUrl: string;
  tokenSource: "personal" | "stored";
  bearerToken: string;
  storesToken: boolean;
}): string | null {
  const example = modelGatewayTypeInfo(f.gatewayType).baseUrlExample;
  const base = normalizeGatewayBaseUrl(f.baseUrl);
  if (!base) return `Where does the gateway listen? (${example})`;
  if (!isValidGatewayUrl(base)) return `The base URL looks like ${example}.`;
  const sync = normalizeGatewayBaseUrl(f.syncUrl);
  if (sync && !isValidGatewayUrl(sync)) return "The sync URL looks like https://…";
  if (f.tokenSource === "stored" && f.storesToken && !f.bearerToken.trim()) {
    return "Enter the shared token, or let each person bring their own.";
  }
  return null;
}

/** "200K" / "1M" — a context window or output limit for a hint. */
export function formatTokens(n: number | undefined): string | null {
  if (!n || n <= 0) return null;
  if (n >= 1_000_000 && n % 100_000 === 0)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** "200K context · 32K max output", for the model picker; null when the catalog says neither. */
export function modelLimitsHint(m: Pick<ModelProviderModel, "contextWindow" | "maxOutputTokens">) {
  const parts: string[] = [];
  const ctx = formatTokens(m.contextWindow);
  const out = formatTokens(m.maxOutputTokens);
  if (ctx) parts.push(`${ctx} context`);
  if (out) parts.push(`${out} max output`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Claude Code reads a `claude-…` model name as one of Anthropic's and keeps
 * that family's context window, not the catalog's: Optio's
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS applies only to names it doesn't know
 * (checked with 2.1.308: `claude-sonnet-internal` ran with 200K though the
 * catalog said 32K; `qwen-internal` with 32K). A smaller window behind such a
 * name isn't honoured, so say so where the catalog is edited.
 */
export function claudeNameWindowWarning(
  m: Pick<ModelProviderModel, "id" | "contextWindow">,
): string | null {
  if (!/^claude-/i.test(m.id.trim())) return null;
  if (!m.contextWindow || m.contextWindow >= 200_000) return null;
  return (
    `Claude Code treats "${m.id.trim()}" as an Anthropic model and assumes its 200K context, ` +
    `not ${formatTokens(m.contextWindow)}. For this limit to apply, give the model a name in the ` +
    `gateway that doesn't start with "claude-" (e.g. corp-sonnet).`
  );
}

/** "OpenRouter · Personal tokens · 3 models · synced 2h ago", for the list (the type when known). */
export function gatewaySummary(
  p: Pick<ModelProvider, "tokenSource" | "models" | "agents" | "lastSyncedAt" | "gatewayType">,
  relative: (iso: string) => string,
): string {
  const count = p.agents.reduce((n, a) => n + (p.models[a]?.length ?? 0), 0);
  const missing = p.agents.reduce(
    (n, a) => n + (p.models[a]?.filter((m) => m.missing).length ?? 0),
    0,
  );
  return [
    ...(p.gatewayType ? [modelGatewayTypeInfo(p.gatewayType).label] : []),
    p.tokenSource === "stored" ? "Shared token" : "Personal tokens",
    `${count} model${count === 1 ? "" : "s"}${missing ? ` (${missing} missing)` : ""}`,
    p.lastSyncedAt ? `synced ${relative(p.lastSyncedAt)}` : "never synced",
  ].join(" · ");
}
