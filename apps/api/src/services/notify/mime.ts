import { randomBytes } from "node:crypto";

/**
 * Plain-text email as the deployment's relay expects it (RFC 5322 + MIME): UTF-8
 * text in quoted-printable and RFC 2047 encoded words in headers, so the
 * message is 7-bit clean and passes any relay, whatever it advertises. No
 * HTML, no attachments: Optio's emails are short and carry links.
 *
 * Header values never take a CR or LF from their input (a title with a
 * newline can't add a header). The SMTP layer (smtp.ts) dot-stuffs.
 */

export interface MailAddress {
  /** The bare address, `optio@example.com`. */
  address: string;
  /** The display name, `Optio`. */
  name?: string | null;
}

export interface MailMessage {
  from: MailAddress;
  to: string[];
  subject: string;
  /** The body, plain text (any line endings). */
  text: string;
  date?: Date;
  messageId?: string;
  /** Extra headers (`X-Optio-Event`), values on one line. */
  headers?: Record<string, string>;
}

// Deliberately simple: one @, no spaces, no angle brackets or quotes.
const ADDRESS_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

/** Whether `s` is an address Optio will put in an envelope. */
export function isEmailAddress(s: string | null | undefined): s is string {
  return !!s && s.length <= 254 && ADDRESS_RE.test(s);
}

/**
 * `Optio <optio@example.com>`, `"Optio, test" <a@b.c>` or `a@b.c` as an
 * address and a display name; null when there is no valid address in it.
 */
export function parseAddress(input: string | null | undefined): MailAddress | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const angled = /^(.*)<([^<>]+)>$/.exec(s);
  if (angled) {
    const address = angled[2].trim();
    if (!isEmailAddress(address)) return null;
    let name = angled[1].trim();
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return { address, name: oneLine(name) || null };
  }
  return isEmailAddress(s) ? { address: s, name: null } : null;
}

/** The address as a header value: `Optio <optio@example.com>`. */
export function formatAddress(a: MailAddress): string {
  const name = oneLine(a.name ?? "");
  if (!name) return a.address;
  if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeWords(name)} <${a.address}>`;
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return `${name} <${a.address}>`;
  return `"${name.replace(/(["\\])/g, "\\$1")}" <${a.address}>`;
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

/**
 * RFC 2047 encoded words (`=?utf-8?B?…?=`), each at most 75 characters,
 * folded with CRLF + space; a multi-byte character never splits.
 */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk: Buffer[] = [];
  let size = 0;
  const flush = () => {
    if (size === 0) return;
    words.push(`=?utf-8?B?${Buffer.concat(chunk).toString("base64")}?=`);
    chunk = [];
    size = 0;
  };
  for (const ch of text) {
    const bytes = Buffer.from(ch, "utf8");
    // 45 bytes → 60 base64 characters; with `=?utf-8?B?` and `?=`, 72.
    if (size + bytes.length > 45) flush();
    chunk.push(bytes);
    size += bytes.length;
  }
  flush();
  return words.join("\r\n ");
}

/** A header value: as is when it is short printable ASCII, else encoded words. */
export function encodeHeaderValue(value: string): string {
  const v = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(v) && v.length <= 900 && !/=\?/.test(v)) return v;
  return encodeWords(v);
}

/**
 * Quoted-printable (RFC 2045 §6.7) of UTF-8 text: CRLF line breaks, lines
 * of at most 76 characters with soft breaks, trailing spaces encoded.
 */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.map(qpLine).join("\r\n");
}

function qpLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  const tokens: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const last = i === bytes.length - 1;
    const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
    tokens.push(
      literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`,
    );
  }
  const out: string[] = [];
  let current = "";
  for (const t of tokens) {
    // 75 + the soft break's "=" makes 76.
    if (current.length + t.length > 75) {
      out.push(`${current}=`);
      current = "";
    }
    current += t;
  }
  out.push(current);
  return out.join("\r\n");
}

/** `<random@domain>` with the From address's domain. */
export function newMessageId(from: MailAddress): string {
  const domain = from.address.split("@")[1] ?? "optio.local";
  return `<${randomBytes(12).toString("hex")}.${Date.now().toString(36)}@${domain}>`;
}

/** RFC 5322 date, `Fri, 24 Oct 2026 10:00:00 +0000`. */
export function formatDate(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "+0000");
}

/** The full message (headers, blank line, body), CRLF line endings. */
export function buildMessage(msg: MailMessage): string {
  const to = msg.to.filter(isEmailAddress);
  const headers: Array<[string, string]> = [
    ["From", formatAddress(msg.from)],
    ["To", to.join(", ")],
    ["Subject", encodeHeaderValue(msg.subject)],
    ["Date", formatDate(msg.date ?? new Date())],
    ["Message-ID", msg.messageId ?? newMessageId(msg.from)],
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=utf-8"],
    ["Content-Transfer-Encoding", "quoted-printable"],
    // RFC 3834: no out-of-office replies to a machine.
    ["Auto-Submitted", "auto-generated"],
  ];
  for (const [name, value] of Object.entries(msg.headers ?? {})) {
    if (/^[A-Za-z0-9-]+$/.test(name)) headers.push([name, encodeHeaderValue(value)]);
  }
  const head = headers.map(([n, v]) => `${n}: ${v}`).join("\r\n");
  return `${head}\r\n\r\n${quotedPrintable(msg.text)}\r\n`;
}
