/**
 * `{{key}}` templates in a connection provider's manifest (MCP env, shell
 * env, health checks): each placeholder is the connection's value for that
 * config key — a secret, a plain config value, or the form's default — and
 * `{{name}}` is the connection's name. An unknown key renders empty, so a
 * var whose template is only placeholders can be dropped when nothing fills
 * it (blank AWS keys → the pod's own role).
 */

export type TemplateLookup = (key: string) => string | undefined;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function renderTemplate(template: string, lookup: TemplateLookup): string {
  return template.replace(PLACEHOLDER, (_m, key: string) => lookup(key) ?? "");
}

/** Whether a template is nothing but placeholders (and whitespace). */
export function isOnlyPlaceholders(template: string): boolean {
  return template.replace(PLACEHOLDER, "").trim() === "";
}

/**
 * Renders a map of env templates, leaving out a var whose template is only
 * placeholders that all rendered empty.
 */
export function renderEnvTemplates(
  templates: Record<string, string>,
  lookup: TemplateLookup,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(templates)) {
    const value = renderTemplate(template, lookup);
    if (value === "" && isOnlyPlaceholders(template)) continue;
    out[name] = value;
  }
  return out;
}

/** The `KEY=VALUE` lines of a custom MCP server's env field. */
export function parseEnvLines(text: string | undefined | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = line.slice(eq + 1).trim();
  }
  return env;
}

/** The lines of a custom MCP server's args field. */
export function parseArgLines(text: string | undefined | null): string[] {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** A file-system-safe slug for a connection's skill directory. */
export function connectionSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "connection";
}
