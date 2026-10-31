import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { vetOutboundUrl } from "@optio/shared/ssrf";

/**
 * A small SMTP client (RFC 5321) for the deployment's relay — the one thing
 * Optio's email needs, without a dependency the offline kit would have to
 * carry: EHLO (HELO as a fallback), STARTTLS or implicit TLS (`smtps`), AUTH
 * PLAIN or LOGIN, one message to one or more recipients.
 *
 * TLS trusts Node's roots plus `NODE_EXTRA_CA_CERTS` (the chart mounts its
 * `caBundle` there), or `caPem` when one is given — the same rule as
 * `oidcFetch` and the gateway client. A password never goes over a
 * connection that isn't encrypted unless the admin chose `none`.
 *
 * Errors are `SmtpError`s whose message says what to fix, never a secret.
 */

export type SmtpSecurity =
  /** Plain TCP, upgraded with STARTTLS when the relay offers it. */
  | "starttls"
  /** Plain TCP, STARTTLS or fail. */
  | "starttls-required"
  /** TLS from the first byte (smtps, port 465). */
  | "tls"
  /** Never encrypt (a relay on the same host or a lab). */
  | "none";

export const SMTP_SECURITIES: readonly SmtpSecurity[] = [
  "starttls",
  "starttls-required",
  "tls",
  "none",
];

export interface SmtpTarget {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string | null;
  password?: string | null;
  /** A CA (PEM) to trust instead of the default roots. */
  caPem?: string | null;
  /** Lab only: don't verify the relay's certificate. */
  insecureSkipVerify?: boolean;
  /** The name Optio gives in EHLO (default: this host's name). */
  clientName?: string;
  /** Per step (connect, each reply). Default 30 s. */
  timeoutMs?: number;
}

export interface SmtpEnvelope {
  from: string;
  to: string[];
  /** The whole message, CRLF line endings (mime.ts `buildMessage`). */
  data: string;
}

export interface SmtpResult {
  accepted: string[];
  rejected: Array<{ address: string; reply: string }>;
  /** The relay's answer to the message (`250 2.0.0 Ok: queued as …`). */
  response: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

/** The port a security mode usually means. */
export function defaultPort(security: SmtpSecurity): number {
  return security === "tls" ? 465 : security === "none" ? 25 : 587;
}

interface Reply {
  code: number;
  lines: string[];
}

const replyText = (r: Reply) => `${r.code} ${r.lines.join(" ").trim()}`.trim();

/** One SMTP conversation over a socket that may be upgraded to TLS. */
class Conversation {
  private buffer = "";
  private lines: string[] = [];
  private waiter: ((line: string | Error) => void) | null = null;
  private failure: Error | null = null;
  private socket!: net.Socket;

  constructor(
    private readonly target: SmtpTarget,
    private readonly timeoutMs: number,
  ) {}

  attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setTimeout(this.timeoutMs);
    // Bytes, not setEncoding: the same socket may be handed to TLS next.
    socket.on("data", (chunk: Buffer) => this.onData(chunk.toString("latin1")));
    socket.on("error", (err) => this.fail(describeSocketError(err, this.target)));
    socket.on("timeout", () =>
      this.fail(new SmtpError(`The relay ${where(this.target)} stopped answering (timeout)`)),
    );
    socket.on("close", () => this.fail(new SmtpError("The relay closed the connection")));
  }

  /**
   * Stop listening on the current socket (before handing it to TLS), and
   * forget anything the relay sent past STARTTLS's reply: it was not
   * encrypted, so it is not to be believed (RFC 3207 §4.2).
   */
  detach(): net.Socket {
    this.buffer = "";
    this.lines = [];
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("timeout");
    this.socket.removeAllListeners("close");
    this.socket.setTimeout(0);
    return this.socket;
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, "");
      this.buffer = this.buffer.slice(i + 1);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(line);
      } else {
        this.lines.push(line);
      }
    }
  }

  private fail(err: Error) {
    if (this.failure) return;
    this.failure = err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(err);
    }
  }

  private nextLine(): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = (line) => (line instanceof Error ? reject(line) : resolve(line));
    });
  }

  async read(): Promise<Reply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
      if (!m) throw new SmtpError(`The relay sent something that isn't SMTP: ${line.slice(0, 80)}`);
      lines.push(m[3]);
      if (m[2] !== "-") return { code: Number(m[1]), lines };
    }
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  async command(line: string): Promise<Reply> {
    this.write(line);
    return this.read();
  }

  end(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

function where(t: Pick<SmtpTarget, "host" | "port">) {
  return `${t.host}:${t.port}`;
}

const UNTRUSTED = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_UNTRUSTED",
]);

function describeSocketError(err: Error & { code?: string }, t: SmtpTarget): SmtpError {
  const code = err.code ?? "";
  if (UNTRUSTED.has(code)) {
    return new SmtpError(
      `The relay ${where(t)} uses a certificate this Optio doesn't trust (${code}): add its CA ` +
        "under Settings → Notifications → Email, or to the chart's caBundle",
    );
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return new SmtpError(`The relay's certificate doesn't name ${t.host} (${err.message})`);
  }
  if (code === "CERT_HAS_EXPIRED") return new SmtpError("The relay's certificate has expired");
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ETIMEDOUT"
  ) {
    return new SmtpError(`Could not reach the relay ${where(t)} (${code})`);
  }
  if (/wrong version number|packet length too long|unknown protocol/i.test(err.message)) {
    return new SmtpError(
      `The relay ${where(t)} doesn't speak TLS from the start: choose STARTTLS for this port`,
    );
  }
  return new SmtpError(`SMTP connection to ${where(t)} failed: ${err.message}`);
}

function tlsOptions(t: SmtpTarget): tls.ConnectionOptions {
  const opts: tls.ConnectionOptions = {};
  if (!net.isIP(t.host)) opts.servername = t.host;
  if (t.caPem?.trim()) opts.ca = t.caPem;
  if (t.insecureSkipVerify) opts.rejectUnauthorized = false;
  return opts;
}

/** Socket errors that say this address can't be reached, so the next one is worth a try. */
const UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);

/** This address couldn't be reached (`connectTo`); another may be. */
class UnreachableAddress extends Error {
  constructor(readonly failure: SmtpError) {
    super(failure.message);
  }
}

async function connect(t: SmtpTarget, timeoutMs: number): Promise<net.Socket> {
  // Vet every DNS answer, then connect to a checked address to prevent rebinding.
  // The URL is only the guard's host container; this remains an SMTP socket.
  const host = net.isIP(t.host) === 6 ? `[${t.host}]` : t.host;
  const vetted = await vetOutboundUrl(`https://${host}:${t.port}/`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Each vetted address in turn (IPv6 and IPv4, several records), while the
  // last one couldn't be reached; any other failure (TLS, certificate) stands.
  let failure: SmtpError | undefined;
  for (const { address } of vetted.addresses) {
    try {
      return await connectTo(address, t, timeoutMs);
    } catch (err) {
      if (!(err instanceof UnreachableAddress)) throw err;
      failure = err.failure;
    }
  }
  throw failure ?? new SmtpError(`Could not reach the relay ${where(t)} (no address)`);
}

function connectTo(address: string, t: SmtpTarget, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      t.security === "tls"
        ? tls.connect({ host: address, port: t.port, ...tlsOptions(t) })
        : net.connect({ host: address, port: t.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new UnreachableAddress(new SmtpError(`Could not reach the relay ${where(t)} (timeout)`)),
      );
    }, timeoutMs);
    const onError = (err: Error & { code?: string }) => {
      clearTimeout(timer);
      const failure = describeSocketError(err, t);
      reject(UNREACHABLE.has(err.code ?? "") ? new UnreachableAddress(failure) : failure);
    };
    socket.once("error", onError);
    socket.once(t.security === "tls" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

function upgrade(socket: net.Socket, t: SmtpTarget, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, ...tlsOptions(t) });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new SmtpError(`TLS with the relay ${where(t)} didn't complete (timeout)`));
    }, timeoutMs);
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(describeSocketError(err, t));
    };
    secure.once("error", onError);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      secure.removeListener("error", onError);
      resolve(secure);
    });
  });
}

/** The extensions an EHLO reply lists (`STARTTLS`, `AUTH` → its mechanisms). */
export function parseExtensions(lines: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const [keyword, ...rest] = line.trim().split(/[\s=]+/);
    if (!keyword) continue;
    const key = keyword.toUpperCase();
    out.set(key, [...(out.get(key) ?? []), ...rest.map((r) => r.toUpperCase())]);
  }
  return out;
}

/** `.` at the start of a line gets another (RFC 5321 §4.5.2). */
export function dotStuff(data: string): string {
  return data.replace(/(^|\r\n)\./g, "$1..");
}

function expect(reply: Reply, ok: (code: number) => boolean, what: string): Reply {
  if (!ok(reply.code)) throw new SmtpError(`${what}: ${replyText(reply)}`, reply.code);
  return reply;
}

const is2xx = (c: number) => c >= 200 && c < 300;

/**
 * Send one message. Resolves with the recipients the relay took; rejects
 * when it took none (or refused the message), naming the reply.
 */
export async function smtpSend(target: SmtpTarget, envelope: SmtpEnvelope): Promise<SmtpResult> {
  if (!envelope.to.length) throw new SmtpError("No recipients");
  const timeoutMs = target.timeoutMs ?? 30_000;
  const name = target.clientName ?? (os.hostname() || "optio");
  const conv = new Conversation(target, timeoutMs);
  conv.attach(await connect(target, timeoutMs));
  let encrypted = target.security === "tls";
  try {
    expect(await conv.read(), (c) => c === 220, `The relay ${where(target)} didn't greet`);

    const hello = async () => {
      const ehlo = await conv.command(`EHLO ${name}`);
      if (is2xx(ehlo.code)) return parseExtensions(ehlo.lines);
      expect(await conv.command(`HELO ${name}`), is2xx, "The relay refused HELO");
      return new Map<string, string[]>();
    };
    let ext = await hello();

    if (!encrypted && target.security !== "none") {
      if (ext.has("STARTTLS")) {
        expect(await conv.command("STARTTLS"), (c) => c === 220, "The relay refused STARTTLS");
        const plain = conv.detach();
        conv.attach(await upgrade(plain, target, timeoutMs));
        encrypted = true;
        ext = await hello();
      } else if (target.security === "starttls-required") {
        throw new SmtpError(
          `The relay ${where(target)} doesn't offer STARTTLS; choose None if it really can't encrypt`,
        );
      }
    }

    if (target.username) {
      if (!encrypted && target.security !== "none") {
        throw new SmtpError(
          `The relay ${where(target)} doesn't offer STARTTLS, so Optio won't send the password ` +
            "unencrypted (choose None to allow it)",
        );
      }
      await authenticate(conv, ext, target.username, target.password ?? "");
    }

    expect(
      await conv.command(`MAIL FROM:<${envelope.from}>`),
      is2xx,
      "The relay refused the sender",
    );
    const accepted: string[] = [];
    const rejected: SmtpResult["rejected"] = [];
    for (const to of envelope.to) {
      const r = await conv.command(`RCPT TO:<${to}>`);
      if (is2xx(r.code)) accepted.push(to);
      else rejected.push({ address: to, reply: replyText(r) });
    }
    if (!accepted.length) {
      throw new SmtpError(
        `The relay refused every recipient: ${rejected.map((r) => `${r.address} (${r.reply})`).join("; ")}`,
      );
    }
    expect(await conv.command("DATA"), (c) => c === 354, "The relay refused DATA");
    const body = dotStuff(envelope.data.replace(/\r?\n/g, "\r\n"));
    conv.write(`${body.endsWith("\r\n") ? body : `${body}\r\n`}.`);
    const done = expect(await conv.read(), is2xx, "The relay refused the message");
    conv.write("QUIT");
    return { accepted, rejected, response: replyText(done) };
  } finally {
    conv.end();
  }
}

async function authenticate(
  conv: Conversation,
  ext: Map<string, string[]>,
  username: string,
  password: string,
): Promise<void> {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const refused = (r: Reply) =>
    new SmtpError(
      r.code === 535 || r.code === 534
        ? `The relay refused the user name or password (${replyText(r)})`
        : `The relay refused to sign in: ${replyText(r)}`,
      r.code,
    );
  // A relay that advertises nothing still gets PLAIN, the one every server speaks.
  const offered = ext.get("AUTH") ?? [];
  const mechanism =
    !offered.length || offered.includes("PLAIN")
      ? "PLAIN"
      : offered.includes("LOGIN")
        ? "LOGIN"
        : null;
  if (!mechanism) {
    throw new SmtpError(
      `The relay offers no sign-in Optio speaks (it offers ${offered.join(", ")}; Optio speaks PLAIN and LOGIN)`,
    );
  }
  if (mechanism === "PLAIN") {
    const r = await conv.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`);
    if (r.code !== 235) throw refused(r);
    return;
  }
  const start = await conv.command("AUTH LOGIN");
  if (start.code !== 334) throw refused(start);
  const user = await conv.command(b64(username));
  if (user.code !== 334) throw refused(user);
  const pass = await conv.command(b64(password));
  if (pass.code !== 235) throw refused(pass);
}
