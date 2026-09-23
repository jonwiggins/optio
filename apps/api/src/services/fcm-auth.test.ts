import { describe, expect, it, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  FCM_OAUTH_SCOPE,
  GOOGLE_TOKEN_URL,
  GoogleAccessTokenProvider,
  ServiceAccountError,
  TOKEN_FAILURE_BACKOFF_MS,
  TokenExchangeError,
  parseServiceAccount,
  signServiceAccountJwt,
} from "./fcm-auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const SA_JSON = {
  type: "service_account",
  project_id: "optio-test",
  private_key_id: "kid-123",
  private_key: PEM,
  client_email: "fcm@optio-test.iam.gserviceaccount.com",
  client_id: "1",
  token_uri: "https://oauth2.googleapis.com/token",
};

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("parseServiceAccount", () => {
  it("reads the downloaded key JSON", () => {
    expect(parseServiceAccount(JSON.stringify(SA_JSON))).toEqual({
      clientEmail: SA_JSON.client_email,
      privateKey: PEM.trim(),
      privateKeyId: "kid-123",
      projectId: "optio-test",
    });
  });

  it("accepts base64 of the JSON and literal \\n escapes in the key", () => {
    const escaped = JSON.stringify({ ...SA_JSON, private_key: PEM.replaceAll("\n", "\\n") });
    // JSON.stringify escapes the backslash, so the parsed key holds a literal "\n" sequence.
    expect(parseServiceAccount(escaped).privateKey).toBe(PEM.trim());
    const b64 = Buffer.from(JSON.stringify(SA_JSON)).toString("base64");
    expect(parseServiceAccount(b64).clientEmail).toBe(SA_JSON.client_email);
  });

  it("rejects broken keys with a reason that never echoes key material", () => {
    const bad = (raw: string) => {
      try {
        parseServiceAccount(raw);
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceAccountError);
        expect((err as Error).message).not.toContain("PRIVATE KEY");
        return (err as Error).message;
      }
      throw new Error("expected a ServiceAccountError");
    };
    expect(bad("")).toBe("empty");
    expect(bad("{not json")).toBe("not valid JSON");
    expect(bad("definitely not base64 json")).toMatch(/not JSON/);
    expect(bad(JSON.stringify({ ...SA_JSON, client_email: "" }))).toBe("client_email missing");
    expect(bad(JSON.stringify({ ...SA_JSON, private_key: undefined }))).toBe("private_key missing");
    expect(
      bad(JSON.stringify({ ...SA_JSON, private_key: "-----BEGIN PRIVATE KEY-----\nxx" })),
    ).toBe("private_key is not a valid PEM key");
    expect(bad(JSON.stringify({ ...SA_JSON, type: "authorized_user" }))).toMatch(
      /expected "service_account"/,
    );
  });
});

describe("signServiceAccountJwt", () => {
  it("signs an RS256 JWT bearer assertion for the FCM scope that verifies with the public key", () => {
    const sa = parseServiceAccount(JSON.stringify(SA_JSON));
    const now = new Date("2026-09-17T12:00:00Z");
    const jwt = signServiceAccountJwt(sa, { now });
    const [h, c, s] = jwt.split(".");
    expect(decodePart(h)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-123" });
    expect(decodePart(c)).toEqual({
      iss: SA_JSON.client_email,
      scope: FCM_OAUTH_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: 1789646400,
      exp: 1789646400 + 3600,
    });
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
});

function tokenResponse(token: string, expiresIn = 3599, status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? { access_token: token, expires_in: expiresIn, token_type: "Bearer" }
        : { error: "invalid_grant", error_description: "Invalid JWT Signature." },
    ),
    { status, headers: { "content-type": "application/json" } },
  );
}

function provider(fetchImpl: ReturnType<typeof vi.fn>, clock: { ms: number }) {
  return new GoogleAccessTokenProvider({
    serviceAccount: parseServiceAccount(JSON.stringify(SA_JSON)),
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => new Date(clock.ms),
  });
}

describe("GoogleAccessTokenProvider", () => {
  it("exchanges a JWT at the token endpoint and caches the token until shortly before expiry", async () => {
    const clock = { ms: Date.parse("2026-09-17T12:00:00Z") };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("ya29.first"))
      .mockResolvedValueOnce(tokenResponse("ya29.second"));
    const tokens = provider(fetchImpl, clock);

    expect(await tokens.get()).toBe("ya29.first");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(init.body as string);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(decodePart(form.get("assertion")!.split(".")[1]).iss).toBe(SA_JSON.client_email);

    // Cached well inside the lifetime…
    clock.ms += 3599_000 - ACCESS_TOKEN_REFRESH_MARGIN_MS - 1000;
    expect(await tokens.get()).toBe("ya29.first");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // …and refreshed inside the margin before expiry.
    clock.ms += 2000;
    expect(await tokens.get()).toBe("ya29.second");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one exchange between concurrent callers and re-mints after invalidate()", async () => {
    const clock = { ms: 0 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return tokenResponse("ya29.a");
      })
      .mockResolvedValueOnce(tokenResponse("ya29.b"));
    const tokens = provider(fetchImpl, clock);
    const pending = [tokens.get(), tokens.get(), tokens.get()];
    release();
    expect(await Promise.all(pending)).toEqual(["ya29.a", "ya29.a", "ya29.a"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    tokens.invalidate();
    expect(await tokens.get()).toBe("ya29.b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed exchange, fails fast during the backoff, then retries", async () => {
    const clock = { ms: 0 };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("", 0, 400))
      .mockResolvedValueOnce(tokenResponse("ya29.ok"));
    const tokens = provider(fetchImpl, clock);

    const first = await tokens.get().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(TokenExchangeError);
    expect((first as TokenExchangeError).status).toBe(400);
    expect((first as Error).message).toContain("invalid_grant");

    clock.ms += TOKEN_FAILURE_BACKOFF_MS - 1;
    await expect(tokens.get()).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock.ms += 2;
    expect(await tokens.get()).toBe("ya29.ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports an unreachable token endpoint as status 0", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
    const err = await provider(fetchImpl, { ms: 0 })
      .get()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenExchangeError);
    expect((err as TokenExchangeError).status).toBe(0);
    expect((err as Error).message).toContain("ECONNRESET");
  });
});
