import { describe, expect, it } from "vitest";
import {
  buildMessage,
  encodeHeaderValue,
  encodeWords,
  formatAddress,
  isEmailAddress,
  parseAddress,
  quotedPrintable,
} from "./mime.js";

/** Decode RFC 2047 B-words back to text. */
function decodeWords(s: string): string {
  return s
    .split(/\r\n /)
    .map((w) => /^=\?utf-8\?B\?(.*)\?=$/.exec(w)?.[1] ?? "")
    .map((b) => Buffer.from(b, "base64"))
    .reduce((acc, b) => Buffer.concat([acc, b]), Buffer.alloc(0))
    .toString("utf8");
}

/** Decode quoted-printable back to text. */
function decodeQp(s: string): string {
  const joined = s.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=") {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(joined.charCodeAt(i));
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
}

describe("addresses", () => {
  it("accepts a plain address and refuses what could smuggle a header or a second recipient", () => {
    expect(isEmailAddress("bob@example.test")).toBe(true);
    expect(isEmailAddress("bob@corp")).toBe(false);
    expect(isEmailAddress("bob@example.test\r\nBcc: x@y.z")).toBe(false);
    expect(isEmailAddress("a@b.c, d@e.f")).toBe(false);
    expect(isEmailAddress("<a@b.c>")).toBe(false);
  });

  it("parses the From forms people type", () => {
    expect(parseAddress("Optio <optio@example.com>")).toEqual({
      address: "optio@example.com",
      name: "Optio",
    });
    expect(parseAddress('"Optio, test" <o@example.com>')).toEqual({
      address: "o@example.com",
      name: "Optio, test",
    });
    expect(parseAddress("o@example.com")).toEqual({ address: "o@example.com", name: null });
    expect(parseAddress("Optio")).toBeNull();
    expect(parseAddress("")).toBeNull();
  });

  it("formats a display name: as is, quoted, or encoded", () => {
    expect(formatAddress({ address: "o@c.example", name: "Optio" })).toBe("Optio <o@c.example>");
    expect(formatAddress({ address: "o@c.example", name: "Optio, test" })).toBe(
      '"Optio, test" <o@c.example>',
    );
    const encoded = formatAddress({ address: "o@c.example", name: "אופטיו" });
    expect(encoded).toMatch(/^=\?utf-8\?B\?.*\?= <o@c\.example>$/);
    expect(decodeWords(encoded.replace(/ <o@c\.example>$/, ""))).toBe("אופטיו");
  });
});

describe("headers", () => {
  it("encodes non-ASCII into words of at most 75 characters that decode back", () => {
    const subject = "Merge request waiting for you: תיקון הבאג בדף הכניסה של המערכת 🚀 ".repeat(3);
    const words = encodeWords(subject);
    for (const w of words.split("\r\n ")) expect(w.length).toBeLessThanOrEqual(75);
    expect(decodeWords(words)).toBe(subject);
  });

  it("keeps short ASCII as it is and never lets a newline through", () => {
    expect(encodeHeaderValue("Merge request waiting for you")).toBe(
      "Merge request waiting for you",
    );
    expect(encodeHeaderValue("a\r\nBcc: evil@x.y")).toBe("a Bcc: evil@x.y");
  });
});

describe("quoted-printable", () => {
  it("round-trips UTF-8 text with lines of at most 76 characters", () => {
    const text = `${"x".repeat(200)}\nשלום עולם = 1 \ttab\n.dot line\n`;
    const qp = quotedPrintable(text);
    for (const line of qp.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(decodeQp(qp)).toBe(text);
  });

  it("encodes '=' and whitespace at the end of a line", () => {
    expect(quotedPrintable("a=b")).toBe("a=3Db");
    expect(quotedPrintable("trailing ")).toBe("trailing=20");
    expect(quotedPrintable("-- \nsig")).toBe("--=20\r\nsig");
  });
});

describe("buildMessage", () => {
  it("writes the headers a relay and a mail client expect, CRLF throughout", () => {
    const msg = buildMessage({
      from: { address: "optio@example.com", name: "Optio" },
      to: ["bob@example.com", "not an address"],
      subject: "[Optio] Failed: Fix login\r\nBcc: evil@x.y",
      text: "Line one\nLine two",
      date: new Date("2026-10-24T10:00:00Z"),
      messageId: "<id@example.com>",
      headers: { "X-Optio-Event": "task.failed", "Bad Header": "x" },
    });
    const [head, body] = msg.split("\r\n\r\n");
    expect(head).toContain("From: Optio <optio@example.com>");
    expect(head).toContain("To: bob@example.com\r\n");
    expect(head).toContain("Subject: [Optio] Failed: Fix login Bcc: evil@x.y");
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toContain("Date: Sat, 24 Oct 2026 10:00:00 +0000");
    expect(head).toContain("Message-ID: <id@example.com>");
    expect(head).toContain("Content-Type: text/plain; charset=utf-8");
    expect(head).toContain("Content-Transfer-Encoding: quoted-printable");
    expect(head).toContain("Auto-Submitted: auto-generated");
    expect(head).toContain("X-Optio-Event: task.failed");
    expect(head).not.toContain("Bad Header");
    expect(body).toBe("Line one\r\nLine two\r\n");
    expect(msg).not.toMatch(/[^\r]\n/);
  });
});
