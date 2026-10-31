import net from "node:net";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vetOutboundUrl } from "@optio/shared/ssrf";
import { dotStuff, parseExtensions, smtpSend, type SmtpTarget } from "./smtp.js";

vi.mock("@optio/shared/ssrf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@optio/shared/ssrf")>();
  return { ...real, vetOutboundUrl: vi.fn(real.vetOutboundUrl) };
});

/**
 * A self-signed certificate for `localhost` / 127.0.0.1 (and its key), made
 * for this test alone with `openssl req -x509 -newkey ec -pkeyopt
 * ec_paramgen_curve:prime256v1 -days 36500 -nodes -subj /CN=localhost
 * -addext subjectAltName=DNS:localhost,IP:127.0.0.1`: the private CA a
 * site's relay would have.
 */
const KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg2LY1cb1+is41P3oO",
  "U33NZtUOwJJKK2qx5BP8uh2EUMehRANCAARhT2QgwlVkBFVZSqkp2fwCDqxt03RH",
  "CWp4QY4Vm+4uuatFx2vkKEYOcMVtSm7fRziCxZ5u5m7yM0yACxMqVW8H",
  "-----END PRIVATE KEY-----",
].join("\n");
const CERT = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBmzCCAUGgAwIBAgIUFnEFuhjHKh2dRQ3JDs8OQNOPBm0wCgYIKoZIzj0EAwIw",
  "FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyNDA0MDIxNloYDzIxMjYwOTMw",
  "MDQwMjE2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO",
  "PQMBBwNCAARhT2QgwlVkBFVZSqkp2fwCDqxt03RHCWp4QY4Vm+4uuatFx2vkKEYO",
  "cMVtSm7fRziCxZ5u5m7yM0yACxMqVW8Ho28wbTAdBgNVHQ4EFgQUsz+p+fx7R4+Z",
  "hzJQUoo2j+9X/pQwHwYDVR0jBBgwFoAUsz+p+fx7R4+ZhzJQUoo2j+9X/pQwDwYD",
  "VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI",
  "zj0EAwIDSAAwRQIhALJDbHytJ6sXyaxd7ETLcok7p8HEK5uA41K9tQNxzS4hAiBa",
  "b7hp49Tg0cvBaQ/DMrw4XrmQKIaoh+NOvN96pnWaLA==",
  "-----END CERTIFICATE-----",
].join("\n");

interface FakeRelayOptions {
  starttls?: boolean;
  implicitTls?: boolean;
  auth?: Array<"PLAIN" | "LOGIN" | "CRAM-MD5">;
  user?: { name: string; pass: string };
  rejectRcpt?: (address: string) => boolean;
  /** Extra greeting lines (a multi-line 220). */
  greeting?: string[];
  /** Sent right after the STARTTLS reply, before TLS: must be ignored. */
  injectAfterStarttls?: string;
}

interface Received {
  from: string | null;
  to: string[];
  data: string | null;
  authedAs: string | null;
  /** Each command with whether the connection was encrypted then. */
  commands: Array<{ line: string; secure: boolean }>;
}

const servers: net.Server[] = [];

beforeEach(() => vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1,localhost"));

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** A relay that speaks just enough SMTP, recording what it was told. */
async function fakeRelay(
  opts: FakeRelayOptions = {},
): Promise<{ port: number; received: Received }> {
  const received: Received = { from: null, to: [], data: null, authedAs: null, commands: [] };
  const serve = (raw: net.Socket) => {
    let socket: net.Socket = raw;
    let secure = !!opts.implicitTls;
    let buffer = "";
    let mode: "cmd" | "data" | "login-user" | "login-pass" = "cmd";
    let loginUser = "";
    const dataLines: string[] = [];
    const send = (s: string) => socket.write(`${s}\r\n`);
    const onLine = (line: string) => {
      if (mode === "data") {
        if (line === ".") {
          mode = "cmd";
          received.data = dataLines.map((l) => (l.startsWith("..") ? l.slice(1) : l)).join("\r\n");
          return send("250 2.0.0 Ok: queued as FAKE1");
        }
        dataLines.push(line);
        return;
      }
      if (mode === "login-user") {
        loginUser = Buffer.from(line, "base64").toString();
        mode = "login-pass";
        return send("334 UGFzc3dvcmQ6");
      }
      if (mode === "login-pass") {
        mode = "cmd";
        const pass = Buffer.from(line, "base64").toString();
        if (loginUser === opts.user?.name && pass === opts.user?.pass) {
          received.authedAs = loginUser;
          return send("235 2.7.0 Authentication successful");
        }
        return send("535 5.7.8 Authentication credentials invalid");
      }
      received.commands.push({ line, secure });
      const [verb] = line.split(" ");
      switch (verb.toUpperCase()) {
        case "EHLO": {
          const ext = ["250-fake.relay"];
          if (opts.starttls && !secure) ext.push("250-STARTTLS");
          if (opts.auth?.length) ext.push(`250-AUTH ${opts.auth.join(" ")}`);
          ext.push("250 SIZE 10240000");
          return socket.write(`${ext.join("\r\n")}\r\n`);
        }
        case "STARTTLS": {
          // One write, so the injected line arrives with the reply (as a MITM would send it).
          socket.write(
            `220 2.0.0 Ready to start TLS\r\n${opts.injectAfterStarttls ? `${opts.injectAfterStarttls}\r\n` : ""}`,
          );
          socket.removeAllListeners("data");
          const upgraded = new tls.TLSSocket(socket, { isServer: true, key: KEY, cert: CERT });
          socket = upgraded;
          secure = true;
          buffer = "";
          upgraded.on("data", onData);
          upgraded.on("error", () => {});
          return;
        }
        case "AUTH": {
          const [, mech, arg] = line.split(" ");
          if (mech === "PLAIN") {
            const [, user, pass] = Buffer.from(arg ?? "", "base64")
              .toString()
              .split("\0");
            if (user === opts.user?.name && pass === opts.user?.pass) {
              received.authedAs = user;
              return send("235 2.7.0 Authentication successful");
            }
            return send("535 5.7.8 Authentication credentials invalid");
          }
          if (mech === "LOGIN") {
            mode = "login-user";
            return send("334 VXNlcm5hbWU6");
          }
          return send("504 5.5.4 Unrecognized authentication type");
        }
        case "MAIL":
          received.from = /<(.*)>/.exec(line)?.[1] ?? null;
          return send("250 2.1.0 Ok");
        case "RCPT": {
          const to = /<(.*)>/.exec(line)?.[1] ?? "";
          if (opts.rejectRcpt?.(to))
            return send("550 5.1.1 <" + to + ">: Recipient address rejected");
          received.to.push(to);
          return send("250 2.1.5 Ok");
        }
        case "DATA":
          mode = "data";
          return send("354 End data with <CR><LF>.<CR><LF>");
        case "QUIT":
          send("221 2.0.0 Bye");
          return socket.end();
        default:
          return send("502 5.5.2 Error: command not recognized");
      }
    };
    function onData(chunk: Buffer) {
      buffer += chunk.toString("latin1");
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        onLine(line);
      }
    }
    socket.on("data", onData);
    socket.on("error", () => {});
    for (const g of opts.greeting ?? []) send(`220-${g}`);
    send("220 fake.relay ESMTP");
  };
  const server = opts.implicitTls
    ? tls.createServer({ key: KEY, cert: CERT }, serve)
    : net.createServer(serve);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, received };
}

const message = "Subject: hi\r\n\r\nHello\r\n.leading dot\r\n";
const send = (target: SmtpTarget, to = ["bob@example.test"]) =>
  smtpSend(
    { timeoutMs: 5000, clientName: "optio.test", ...target },
    {
      from: "optio@example.test",
      to,
      data: message,
    },
  );

describe("smtpSend", () => {
  it("delivers over plain SMTP when the relay offers no TLS (security none)", async () => {
    const relay = await fakeRelay({ greeting: ["welcome", "to the relay"] });
    const r = await send({ host: "127.0.0.1", port: relay.port, security: "none" });
    expect(r.accepted).toEqual(["bob@example.test"]);
    expect(r.response).toMatch(/^250 2\.0\.0 Ok: queued/);
    expect(relay.received.from).toBe("optio@example.test");
    expect(relay.received.commands[0].line).toBe("EHLO optio.test");
    // Dot-stuffed on the wire, unstuffed by the relay: the body arrives as written.
    expect(relay.received.data).toBe("Subject: hi\r\n\r\nHello\r\n.leading dot");
  });

  it("upgrades with STARTTLS, trusting the deployment's CA, then signs in with PLAIN", async () => {
    const relay = await fakeRelay({
      starttls: true,
      auth: ["PLAIN", "LOGIN"],
      user: { name: "optio", pass: "s3cret" },
    });
    await send({
      host: "127.0.0.1",
      port: relay.port,
      security: "starttls",
      username: "optio",
      password: "s3cret",
      caPem: CERT,
    });
    expect(relay.received.authedAs).toBe("optio");
    const auth = relay.received.commands.find((c) => c.line.startsWith("AUTH"));
    expect(auth?.secure).toBe(true);
    expect(relay.received.commands.filter((c) => c.line.startsWith("EHLO"))).toHaveLength(2);
  });

  it("ignores what the relay sent past STARTTLS's reply in the clear", async () => {
    const relay = await fakeRelay({ starttls: true, injectAfterStarttls: "250 injected" });
    const r = await send({
      host: "127.0.0.1",
      port: relay.port,
      security: "starttls",
      caPem: CERT,
    });
    expect(r.accepted).toEqual(["bob@example.test"]);
  });

  it("signs in with LOGIN when the relay offers only that", async () => {
    const relay = await fakeRelay({
      starttls: true,
      auth: ["LOGIN"],
      user: { name: "optio", pass: "pw" },
    });
    await send({
      host: "127.0.0.1",
      port: relay.port,
      security: "starttls-required",
      username: "optio",
      password: "pw",
      caPem: CERT,
    });
    expect(relay.received.authedAs).toBe("optio");
  });

  it("speaks TLS from the first byte for smtps", async () => {
    const relay = await fakeRelay({ implicitTls: true });
    const r = await send({ host: "127.0.0.1", port: relay.port, security: "tls", caPem: CERT });
    expect(r.accepted).toEqual(["bob@example.test"]);
    expect(relay.received.commands[0].secure).toBe(true);
  });

  it("says to add the CA when the relay's certificate isn't trusted", async () => {
    const relay = await fakeRelay({ starttls: true });
    await expect(
      send({ host: "127.0.0.1", port: relay.port, security: "starttls-required" }),
    ).rejects.toThrow(/certificate this Optio doesn't trust.*Settings → Notifications → Email/);
  });

  it("skips verification only when told to (a lab)", async () => {
    const relay = await fakeRelay({ starttls: true });
    const r = await send({
      host: "127.0.0.1",
      port: relay.port,
      security: "starttls-required",
      insecureSkipVerify: true,
    });
    expect(r.accepted).toHaveLength(1);
  });

  it("fails when STARTTLS is required and not offered", async () => {
    const relay = await fakeRelay({});
    await expect(
      send({ host: "127.0.0.1", port: relay.port, security: "starttls-required" }),
    ).rejects.toThrow(/doesn't offer STARTTLS/);
  });

  it("never sends a password unencrypted unless security is none", async () => {
    const relay = await fakeRelay({ auth: ["PLAIN"], user: { name: "u", pass: "p" } });
    await expect(
      send({
        host: "127.0.0.1",
        port: relay.port,
        security: "starttls",
        username: "u",
        password: "p",
      }),
    ).rejects.toThrow(/won't send the password unencrypted/);
    expect(relay.received.commands.some((c) => c.line.startsWith("AUTH"))).toBe(false);
  });

  it("names a wrong password", async () => {
    const relay = await fakeRelay({ auth: ["PLAIN"], user: { name: "u", pass: "p" } });
    await expect(
      send({ host: "127.0.0.1", port: relay.port, security: "none", username: "u", password: "x" }),
    ).rejects.toThrow(/refused the user name or password \(535/);
  });

  it("refuses a relay that offers only mechanisms Optio doesn't speak", async () => {
    const relay = await fakeRelay({ auth: ["CRAM-MD5"], user: { name: "u", pass: "p" } });
    await expect(
      send({ host: "127.0.0.1", port: relay.port, security: "none", username: "u", password: "p" }),
    ).rejects.toThrow(/offers no sign-in Optio speaks \(it offers CRAM-MD5/);
  });

  it("delivers to the recipients the relay takes and reports the others", async () => {
    const relay = await fakeRelay({ rejectRcpt: (a) => a.startsWith("gone") });
    const r = await send({ host: "127.0.0.1", port: relay.port, security: "none" }, [
      "bob@example.test",
      "gone@example.test",
    ]);
    expect(r.accepted).toEqual(["bob@example.test"]);
    expect(r.rejected).toEqual([
      { address: "gone@example.test", reply: expect.stringMatching(/^550 /) },
    ]);
  });

  it("fails when every recipient is refused", async () => {
    const relay = await fakeRelay({ rejectRcpt: () => true });
    await expect(
      send({ host: "127.0.0.1", port: relay.port, security: "none" }, ["gone@example.test"]),
    ).rejects.toThrow(/refused every recipient: gone@example\.test \(550/);
    expect(relay.received.commands.some((c) => c.line === "DATA")).toBe(false);
  });

  it("says when the relay can't be reached", async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(send({ host: "127.0.0.1", port, security: "none" })).rejects.toThrow(
      /Could not reach the relay 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/,
    );
  });

  it("tries the relay's next vetted address when one can't be reached", async () => {
    const relay = await fakeRelay({});
    // The relay listens on 127.0.0.1 only: 127.0.0.2 refuses the connection.
    vi.mocked(vetOutboundUrl).mockResolvedValueOnce({
      url: new URL(`https://relay.example.test:${relay.port}/`),
      hostname: "relay.example.test",
      addresses: [
        { address: "127.0.0.2", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    const r = await send({ host: "relay.example.test", port: relay.port, security: "none" });
    expect(r.accepted).toEqual(["bob@example.test"]);
  });
});

describe("protocol helpers", () => {
  it("reads EHLO extensions, AUTH mechanisms included (both spellings)", () => {
    const ext = parseExtensions([
      "relay",
      "STARTTLS",
      "AUTH PLAIN LOGIN",
      "AUTH=XOAUTH2",
      "SIZE 100",
    ]);
    expect(ext.has("STARTTLS")).toBe(true);
    expect(ext.get("AUTH")).toEqual(["PLAIN", "LOGIN", "XOAUTH2"]);
    expect(ext.get("SIZE")).toEqual(["100"]);
  });

  it("doubles a dot at the start of any line", () => {
    expect(dotStuff(".a\r\nb\r\n.\r\n..c")).toBe("..a\r\nb\r\n..\r\n...c");
  });
});

describe("SMTP outbound policy", () => {
  it.each(["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1"])(
    "blocks %s before opening a socket unless the administrator allows it",
    async (host) => {
      vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "");
      vi.stubEnv("OPTIO_OUTBOUND_ALLOW_PRIVATE", "false");
      await expect(
        smtpSend(
          { host, port: 25, security: "none" },
          {
            from: "optio@example.test",
            to: ["person@example.test"],
            data: "private",
          },
        ),
      ).rejects.toThrow(/blocked/);
    },
  );
});
