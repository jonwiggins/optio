import { isIP } from "node:net";
import { runtimeClassNameError } from "@optio/shared";

/**
 * The agent policy's deployment-wide settings (docs/agent-policy.md): the
 * chart's values, as env, so only the operator changes them. Kept apart
 * from services/agent-policy.ts (no database) because pod placement and the
 * restricted repo NetworkPolicy read them on every pod they make.
 */

const TRUE = new Set(["true", "1", "yes", "on"]);

/** Whether the operator turned the built-in rules on for every workspace. */
export function deploymentBuiltInRules(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUE.has((env.OPTIO_AGENT_POLICY_DEFAULTS ?? "").trim().toLowerCase());
}

/**
 * The RuntimeClass every agent pod runs under (`agent.runtimeClassName`);
 * null = the cluster's default runtime. A value that isn't a RuntimeClass
 * name throws, so no pod starts without the sandbox the operator asked for.
 */
export function deploymentRuntimeClass(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = env.OPTIO_AGENT_RUNTIME_CLASS?.trim();
  if (!name) return null;
  const err = runtimeClassNameError(name);
  if (err) throw new Error(`OPTIO_AGENT_RUNTIME_CLASS: ${err}`);
  return name;
}

/** One allowlist entry as the chart's `networkPolicy.agentEgress` holds it. */
export interface AgentEgressEntry {
  name?: string;
  cidr?: string;
  cidrs?: string[];
  except?: string[];
  namespace?: string;
  podLabels?: Record<string, string>;
  ports?: number[];
}

/** Where agent pods may connect, for Workspace settings → Agent policy. */
export interface AgentEgressView {
  /**
   * `allowlist`: DNS, the Optio API and the entries only. `default`: the
   * chart's NetworkPolicy without an allowlist (public addresses on 443 and
   * 80). `not-set`: the API has no allowlist from the chart (the
   * NetworkPolicy may still be on). `invalid`: the setting can't be read.
   */
  mode: "allowlist" | "default" | "not-set" | "invalid";
  entries: Array<{ name: string; to: string[]; ports: number[] }>;
  error?: string;
}

const ENTRY_KEYS = new Set(["name", "cidr", "cidrs", "except", "namespace", "podLabels", "ports"]);
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** Whether `cidr` is an IPv4 or IPv6 network (`10.0.0.0/8`), never the whole internet. */
export function cidrError(cidr: unknown): string | null {
  if (typeof cidr !== "string") return `${JSON.stringify(cidr)} isn't a CIDR`;
  const [addr, bits, ...rest] = cidr.split("/");
  const family = addr ? isIP(addr) : 0;
  if (rest.length > 0 || !family || !bits || !/^\d{1,3}$/.test(bits)) {
    return `"${cidr}" isn't a CIDR (address/prefix, e.g. 10.20.0.15/32)`;
  }
  const prefix = Number(bits);
  if (prefix > (family === 4 ? 32 : 128)) return `"${cidr}" has a prefix that is too long`;
  if (prefix === 0) return `"${cidr}" allows every address; leave the allowlist empty instead`;
  return null;
}

/**
 * What's wrong with one `networkPolicy.agentEgress` entry, or null. The
 * chart refuses the same things at render time (helm _helpers.tpl
 * `optio.validateAgentEgress`); this is for the API's view.
 */
export function egressEntryError(entry: unknown, i: number): string | null {
  const at = `networkPolicy.agentEgress[${i}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `${at} isn't an object`;
  const e = entry as Record<string, unknown>;
  const unknown = Object.keys(e).filter((k) => !ENTRY_KEYS.has(k));
  if (unknown.length > 0) {
    return `${at} has ${unknown.join(", ")}: NetworkPolicy takes addresses and pods, not host names`;
  }
  const cidrs = [
    ...(e.cidr !== undefined ? [e.cidr] : []),
    ...(Array.isArray(e.cidrs) ? e.cidrs : []),
  ];
  if (e.cidrs !== undefined && !Array.isArray(e.cidrs)) return `${at}.cidrs isn't a list`;
  if (cidrs.length === 0 && e.namespace === undefined) {
    return `${at} needs cidr, cidrs or namespace: an entry with none would allow every destination`;
  }
  for (const c of [...cidrs, ...(Array.isArray(e.except) ? e.except : [])]) {
    const err = cidrError(c);
    if (err) return `${at}: ${err}`;
  }
  if (e.except !== undefined && (!Array.isArray(e.except) || cidrs.length === 0)) {
    return `${at}.except needs a list next to cidr or cidrs`;
  }
  if (
    e.namespace !== undefined &&
    (typeof e.namespace !== "string" || !DNS_LABEL.test(e.namespace))
  ) {
    return `${at}.namespace isn't a namespace name`;
  }
  if (
    e.podLabels !== undefined &&
    (typeof e.podLabels !== "object" ||
      e.podLabels === null ||
      Object.values(e.podLabels).some((v) => typeof v !== "string"))
  ) {
    return `${at}.podLabels isn't a map of strings`;
  }
  if (
    e.ports !== undefined &&
    (!Array.isArray(e.ports) ||
      e.ports.length === 0 ||
      e.ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535))
  ) {
    return `${at}.ports must be a list of ports (1-65535)`;
  }
  return null;
}

/** The chart's allowlist (`OPTIO_AGENT_EGRESS`: a JSON list of entries). */
export function agentEgress(env: NodeJS.ProcessEnv = process.env): AgentEgressView {
  const raw = env.OPTIO_AGENT_EGRESS?.trim();
  if (!raw) return { mode: "not-set", entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mode: "invalid", entries: [], error: "OPTIO_AGENT_EGRESS isn't JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { mode: "invalid", entries: [], error: "OPTIO_AGENT_EGRESS isn't a list" };
  }
  for (const [i, e] of parsed.entries()) {
    const error = egressEntryError(e, i);
    if (error) return { mode: "invalid", entries: [], error };
  }
  const entries = (parsed as AgentEgressEntry[]).map((e, i) => ({
    name: e.name?.trim() || `Entry ${i + 1}`,
    to: [
      ...(e.cidr ? [e.cidr] : []),
      ...(e.cidrs ?? []),
      ...(e.except?.length ? [`except ${e.except.join(", ")}`] : []),
      ...(e.namespace
        ? [
            `namespace ${e.namespace}` +
              (e.podLabels && Object.keys(e.podLabels).length > 0
                ? `, pods ${Object.entries(e.podLabels)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(",")}`
                : ""),
          ]
        : []),
    ],
    ports: e.ports?.length ? e.ports : [443],
  }));
  return { mode: entries.length > 0 ? "allowlist" : "default", entries };
}

/**
 * Whether the chart's allowlist replaces "public addresses on 443": a
 * restricted repo's own NetworkPolicy (repo-pool-service.ts) then adds DNS
 * and the API only, since NetworkPolicies add up. A setting that can't be
 * read counts as on, so it never widens anything.
 */
export function agentEgressAllowlistOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const { mode } = agentEgress(env);
  return mode === "allowlist" || mode === "invalid";
}
