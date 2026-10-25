import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notifySmtpSettings } from "../../db/schema.js";
import { decrypt, encrypt, ALG_AES_256_GCM_V1 } from "../secret-service.js";
import { parseAddress, type MailAddress } from "./mime.js";
import { defaultPort, SMTP_SECURITIES, type SmtpSecurity, type SmtpTarget } from "./smtp.js";

/**
 * Where Optio's email goes out: the deployment's SMTP relay. A deployment admin
 * saves it under Settings → Notifications (one row, `notify_smtp_settings`),
 * which wins over the deployment's environment (the chart's
 * `notifications.smtp.*`):
 *
 *   OPTIO_SMTP_URL    smtp://[user:pass@]host[:port][?starttls=required|never]
 *                     smtps://[user:pass@]host[:port]      (TLS from the start)
 *   OPTIO_SMTP_FROM   Optio <optio@example.com>  (default optio@<PUBLIC_URL's host>)
 *   OPTIO_SMTP_CA_PEM a CA (PEM) for the relay alone; the chart's caBundle
 *                     (NODE_EXTRA_CA_CERTS) is trusted without it
 *   OPTIO_SMTP_INSECURE_SKIP_VERIFY=true   a lab only
 *
 * Nothing set means no email: the other channels work as before.
 */

export interface SmtpConfig extends SmtpTarget {
  from: MailAddress;
  /** As typed, for the form. */
  fromText: string;
  enabled: boolean;
  source: "app" | "env";
}

export class SmtpConfigError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SmtpConfigError";
  }
}

const AAD = Buffer.from("notify_smtp|default");

/** `OPTIO_SMTP_URL` as a target, or an error to show. */
export function parseSmtpUrl(
  raw: string,
): Omit<SmtpTarget, "caPem" | "insecureSkipVerify"> | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "OPTIO_SMTP_URL isn't a URL (smtp://host:port or smtps://host:port)" };
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "smtp" && scheme !== "smtps") {
    return { error: `OPTIO_SMTP_URL must start with smtp:// or smtps:// (not ${scheme}://)` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { error: "OPTIO_SMTP_URL has no host" };
  const starttls = (url.searchParams.get("starttls") ?? "").toLowerCase();
  const security: SmtpSecurity =
    scheme === "smtps"
      ? "tls"
      : starttls === "required" || starttls === "require"
        ? "starttls-required"
        : starttls === "never" || starttls === "off" || starttls === "false"
          ? "none"
          : "starttls";
  const port = url.port ? Number(url.port) : defaultPort(security);
  return {
    host,
    port,
    security,
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
  };
}

/** The default From: optio@ the host Optio is reached at. */
function defaultFrom(): string | null {
  const pub = process.env.PUBLIC_URL?.trim();
  if (!pub) return null;
  try {
    const host = new URL(pub).hostname;
    return host && host.includes(".") ? `Optio <optio@${host}>` : null;
  } catch {
    return null;
  }
}

/** The environment's relay, or null when `OPTIO_SMTP_URL` is unset; throws a readable error when it's wrong. */
export function envSmtpConfig(): SmtpConfig | null {
  const raw = process.env.OPTIO_SMTP_URL?.trim();
  if (!raw) return null;
  const parsed = parseSmtpUrl(raw);
  if ("error" in parsed) throw new SmtpConfigError(parsed.error);
  const fromText = process.env.OPTIO_SMTP_FROM?.trim() || defaultFrom() || "";
  const from = parseAddress(fromText);
  if (!from) {
    throw new SmtpConfigError(
      fromText
        ? `OPTIO_SMTP_FROM isn't an address: ${fromText}`
        : "Set OPTIO_SMTP_FROM (the address Optio's email comes from)",
    );
  }
  return {
    ...parsed,
    caPem: process.env.OPTIO_SMTP_CA_PEM?.trim() || null,
    insecureSkipVerify: process.env.OPTIO_SMTP_INSECURE_SKIP_VERIFY === "true",
    from,
    fromText,
    enabled: true,
    source: "env",
  };
}

type Row = typeof notifySmtpSettings.$inferSelect;

async function readRow(): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(notifySmtpSettings)
    .where(eq(notifySmtpSettings.id, "default"));
  return row ?? null;
}

function passwordOf(row: Row): string | null {
  if (!row.encryptedPassword || !row.passwordIv || !row.passwordAuthTag) return null;
  return decrypt(
    {
      alg: ALG_AES_256_GCM_V1,
      iv: row.passwordIv,
      ciphertext: row.encryptedPassword,
      authTag: row.passwordAuthTag,
    },
    AAD,
    "SMTP password",
  );
}

function configOfRow(row: Row): SmtpConfig {
  const from = parseAddress(row.fromAddress);
  return {
    host: row.host,
    port: row.port,
    security: row.security,
    username: row.username,
    password: passwordOf(row),
    caPem: row.caPem,
    insecureSkipVerify: row.insecureSkipVerify,
    // Validated on save; a hand-edited row that isn't an address sends nothing.
    from: from ?? { address: "", name: null },
    fromText: row.fromAddress,
    enabled: row.enabled && !!from,
    source: "app",
  };
}

/** The relay in effect: the app's row, else the environment's; null = no email. */
export async function smtpConfig(): Promise<SmtpConfig | null> {
  const row = await readRow();
  if (row) return configOfRow(row);
  return envSmtpConfig();
}

/** What Settings shows (never the password). */
export interface SmtpSettingsView {
  /** Email can go out now. */
  configured: boolean;
  source: "app" | "env" | null;
  enabled: boolean;
  host: string;
  port: number | null;
  security: SmtpSecurity;
  username: string | null;
  hasPassword: boolean;
  from: string;
  caPem: string | null;
  insecureSkipVerify: boolean;
  /** The environment sets a relay (what deleting the app's settings goes back to). */
  envConfigured: boolean;
  /** Why the environment's relay can't be used. */
  envError: string | null;
}

export async function smtpSettingsView(): Promise<SmtpSettingsView> {
  let env: SmtpConfig | null = null;
  let envError: string | null = null;
  try {
    env = envSmtpConfig();
  } catch (err) {
    envError = err instanceof Error ? err.message : String(err);
  }
  const row = await readRow();
  const c = row ? configOfRow(row) : env;
  return {
    configured: !!c && c.enabled,
    source: c?.source ?? null,
    enabled: c?.enabled ?? false,
    host: c?.host ?? "",
    port: c?.port ?? null,
    security: c?.security ?? "starttls",
    username: c?.username ?? null,
    hasPassword: row ? !!row.encryptedPassword : !!env?.password,
    from: c?.fromText ?? defaultFrom() ?? "",
    caPem: c?.caPem ?? null,
    insecureSkipVerify: c?.insecureSkipVerify ?? false,
    envConfigured: !!env || !!envError,
    envError,
  };
}

export interface SaveSmtpSettings {
  host: string;
  port?: number | null;
  security: SmtpSecurity;
  username?: string | null;
  /** Omitted or "" keeps the saved one, null clears it. */
  password?: string | null;
  from: string;
  caPem?: string | null;
  insecureSkipVerify?: boolean;
  enabled?: boolean;
}

function validHost(host: string): boolean {
  return /^[A-Za-z0-9.-]+$/.test(host) || /^[0-9a-fA-F:]+$/.test(host);
}

/**
 * The relay `input` describes, over the saved one (its password when the
 * input keeps it). For saving and for "Send test email" with unsaved values.
 */
export async function configFromInput(input: SaveSmtpSettings): Promise<SmtpConfig> {
  const host = input.host.trim();
  if (!host || !validHost(host)) {
    throw new SmtpConfigError("The host is a name or an address, without smtp:// or a port");
  }
  if (!SMTP_SECURITIES.includes(input.security)) {
    throw new SmtpConfigError(`Unknown security ${input.security}`);
  }
  const port = input.port ?? defaultPort(input.security);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SmtpConfigError("The port is a number from 1 to 65535");
  }
  const fromText = input.from.trim();
  const from = parseAddress(fromText);
  if (!from) {
    throw new SmtpConfigError("The From address is an address, like Optio <optio@example.com>");
  }
  const caPem = input.caPem?.trim() || null;
  if (caPem && !caPem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new SmtpConfigError("The CA certificate is PEM text (-----BEGIN CERTIFICATE-----)");
  }
  const username = input.username?.trim() || null;
  let password: string | null;
  if (input.password === null) password = null;
  else if (input.password) password = input.password;
  else {
    // The stored password goes only to the host and account it was given
    // for: a form that points elsewhere (saved, or just tried) must give it
    // again, so it can't be sent to another server.
    const row = await readRow();
    const stored = row
      ? { host: row.host, username: row.username, password: passwordOf(row) }
      : envSmtpConfigSafe();
    const same =
      !!stored &&
      stored.host.toLowerCase() === host.toLowerCase() &&
      (stored.username ?? null) === username;
    if (username && stored?.password && !same) {
      throw new SmtpConfigError(
        "Enter the password again: the stored one belongs to another host or user name",
      );
    }
    password = same ? (stored?.password ?? null) : null;
  }
  return {
    host,
    port,
    security: input.security,
    username,
    password: username ? password : null,
    caPem,
    insecureSkipVerify: !!input.insecureSkipVerify,
    from,
    fromText,
    enabled: input.enabled ?? true,
    source: "app",
  };
}

function envSmtpConfigSafe(): SmtpConfig | null {
  try {
    return envSmtpConfig();
  } catch {
    return null;
  }
}

/** Save the app's relay (deployment admins; the route checks). */
export async function saveSmtpSettings(
  input: SaveSmtpSettings,
  userId: string | null,
): Promise<SmtpSettingsView> {
  const c = await configFromInput(input);
  const sealed = c.password ? encrypt(c.password, AAD) : null;
  const values = {
    id: "default",
    host: c.host,
    port: c.port,
    security: c.security,
    username: c.username ?? null,
    encryptedPassword: sealed?.ciphertext ?? null,
    passwordIv: sealed?.iv ?? null,
    passwordAuthTag: sealed?.authTag ?? null,
    fromAddress: c.fromText,
    caPem: c.caPem ?? null,
    insecureSkipVerify: !!c.insecureSkipVerify,
    enabled: c.enabled,
    updatedBy: userId,
    updatedAt: new Date(),
  };
  await db
    .insert(notifySmtpSettings)
    .values(values)
    .onConflictDoUpdate({ target: notifySmtpSettings.id, set: values });
  return smtpSettingsView();
}

/** Forget the app's relay: the environment's applies again (or none). */
export async function deleteSmtpSettings(): Promise<SmtpSettingsView> {
  await db.delete(notifySmtpSettings).where(eq(notifySmtpSettings.id, "default"));
  return smtpSettingsView();
}
