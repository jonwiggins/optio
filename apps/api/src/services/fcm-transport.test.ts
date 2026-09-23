import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServiceAccount } from "./fcm-auth.js";
import {
  FakeFcmTransport,
  FcmHttpTransport,
  isUnregisteredFcmResult,
  parseFcmError,
  type FcmSendRequest,
} from "./fcm-transport.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = parseServiceAccount(
  JSON.stringify({
    type: "service_account",
    project_id: "optio-test",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    client_email: "fcm@optio-test.iam.gserviceaccount.com",
  }),
);

const REQ: FcmSendRequest = {
  token: "dev-token:APA91b" + "x".repeat(40),
  data: { type: "alert", title: "Needs you", body: "web" },
  android: { priority: "HIGH", ttl: "86400s" },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fcmError = (
  code: number,
  status: string,
  message: string,
  details: Array<Record<string, unknown>> = [],
) => json(code, { error: { code, message, status, details } });

const fcmCode = (errorCode: string) => ({
  "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
  errorCode,
});

/** Token endpoint + FCM endpoint behind one fetch mock. */
function router(fcmResponses: Array<Response | Error>, tokens = ["ya29.one", "ya29.two"]) {
  let t = 0;
  let f = 0;
  const fetchImpl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/")) {
      return json(200, { access_token: tokens[t++] ?? "ya29.more", expires_in: 3599 });
    }
    const next = fcmResponses[f++];
    if (next instanceof Error) throw next;
    return next ?? json(200, { name: "projects/optio-test/messages/extra" });
  });
  return fetchImpl;
}

function transport(fetchImpl: ReturnType<typeof vi.fn>) {
  return new FcmHttpTransport({
    projectId: "optio-test",
    serviceAccount: SA,
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

describe("FcmHttpTransport", () => {
  it("POSTs the HTTP v1 message with a bearer token from the service account", async () => {
    const fetchImpl = router([json(200, { name: "projects/optio-test/messages/0:123" })]);
    const result = await transport(fetchImpl).send(REQ);
    expect(result).toEqual({ ok: true, name: "projects/optio-test/messages/0:123" });

    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://fcm.googleapis.com/v1/projects/optio-test/messages:send");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ya29.one");
    expect(JSON.parse(init.body as string)).toEqual({
      message: { token: REQ.token, data: REQ.data, android: REQ.android },
    });
  });

  it("reuses the access token across sends", async () => {
    const fetchImpl = router([json(200, {}), json(200, {})]);
    const t = transport(fetchImpl);
    await t.send(REQ);
    await t.send(REQ);
    const tokenCalls = fetchImpl.mock.calls.filter(([u]) => String(u).includes("oauth2"));
    expect(tokenCalls).toHaveLength(1);
  });

  it("re-mints the access token once on 401, then gives up as a server-side failure", async () => {
    const unauth = () => fcmError(401, "UNAUTHENTICATED", "Request had invalid authentication");
    const retried = router([unauth(), json(200, { name: "ok" })]);
    expect(await transport(retried).send(REQ)).toEqual({ ok: true, name: "ok" });
    const auths = retried.mock.calls
      .filter(([u]) => String(u).includes("fcm.googleapis.com"))
      .map(([, init]) => ((init as RequestInit).headers as Record<string, string>).authorization);
    expect(auths).toEqual(["Bearer ya29.one", "Bearer ya29.two"]);

    const stuck = router([unauth(), unauth()]);
    expect(await transport(stuck).send(REQ)).toMatchObject({
      ok: false,
      status: 401,
      reason: "UNAUTHENTICATED",
      serverSide: true,
    });
  });

  it("reports a failed token exchange as auth:… without calling FCM", async () => {
    const fetchImpl = vi.fn(async () =>
      json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." }),
    );
    const result = await transport(fetchImpl).send(REQ);
    expect(result).toMatchObject({ ok: false, status: 0, serverSide: true });
    expect(result.ok === false && result.reason).toMatch(/^auth:.*invalid_grant/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a network error as transport:…", async () => {
    const result = await transport(router([new Error("socket hang up")])).send(REQ);
    expect(result).toEqual({ ok: false, status: 0, reason: "transport:socket hang up" });
    expect(isUnregisteredFcmResult(result)).toBe(false);
  });
});

describe("parseFcmError → drop decisions", () => {
  const parse = async (res: Response) => parseFcmError(res.status, await res.text());

  it("UNREGISTERED / 404 drop the device", async () => {
    const gone = await parse(
      fcmError(404, "NOT_FOUND", "Requested entity was not found.", [fcmCode("UNREGISTERED")]),
    );
    expect(gone).toMatchObject({ status: 404, reason: "UNREGISTERED" });
    expect(isUnregisteredFcmResult(gone)).toBe(true);
    const bare404 = parseFcmError(404, "<html>not found</html>");
    expect(bare404.reason).toBe("HTTP_404");
    expect(isUnregisteredFcmResult(bare404)).toBe(true);
  });

  it("INVALID_ARGUMENT drops the device only when it blames the token", async () => {
    const badToken = await parse(
      fcmError(
        400,
        "INVALID_ARGUMENT",
        "The registration token is not a valid FCM registration token",
        [
          fcmCode("INVALID_ARGUMENT"),
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              { field: "message.token", description: "Invalid registration token" },
            ],
          },
        ],
      ),
    );
    expect(badToken).toMatchObject({ reason: "INVALID_ARGUMENT", tokenInvalid: true });
    expect(isUnregisteredFcmResult(badToken)).toBe(true);

    const badPayload = await parse(
      fcmError(400, "INVALID_ARGUMENT", "Message is too big", [
        fcmCode("INVALID_ARGUMENT"),
        {
          "@type": "type.googleapis.com/google.rpc.BadRequest",
          fieldViolations: [{ field: "message.data", description: "too big" }],
        },
      ]),
    );
    expect(badPayload.tokenInvalid).toBeUndefined();
    expect(isUnregisteredFcmResult(badPayload)).toBe(false);
  });

  it("SENDER_ID_MISMATCH drops (a token from another Firebase project); PERMISSION_DENIED is ours", async () => {
    const foreign = await parse(
      fcmError(403, "PERMISSION_DENIED", "SenderId mismatch", [fcmCode("SENDER_ID_MISMATCH")]),
    );
    expect(foreign.serverSide).toBeUndefined();
    expect(isUnregisteredFcmResult(foreign)).toBe(true);

    const denied = await parse(
      fcmError(403, "PERMISSION_DENIED", "Permission 'cloudmessaging.messages.create' denied"),
    );
    expect(denied).toMatchObject({ reason: "PERMISSION_DENIED", serverSide: true });
    expect(isUnregisteredFcmResult(denied)).toBe(false);
  });

  it("quota and 5xx are plain failures (counted, not dropped)", async () => {
    const quota = await parse(
      fcmError(429, "RESOURCE_EXHAUSTED", "Quota exceeded", [fcmCode("QUOTA_EXCEEDED")]),
    );
    expect(quota).toMatchObject({ status: 429, reason: "QUOTA_EXCEEDED" });
    expect(quota.serverSide).toBeUndefined();
    expect(isUnregisteredFcmResult(quota)).toBe(false);
    const down = parseFcmError(503, "");
    expect(down).toEqual({ ok: false, status: 503, reason: "HTTP_503" });
  });
});

describe("FakeFcmTransport", () => {
  it("records sends, scripts per-token failures, and appends the wire body to the outbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fcm-outbox-"));
    try {
      const outboxFile = join(dir, "sent.jsonl");
      const fake = new FakeFcmTransport({ outboxFile });
      fake.failToken("bad", { ok: false, status: 404, reason: "UNREGISTERED" });

      expect(await fake.send(REQ)).toMatchObject({ ok: true });
      expect(await fake.send({ ...REQ, token: "bad" })).toMatchObject({ reason: "UNREGISTERED" });
      await fake.send({
        token: REQ.token,
        data: { type: "watch", event: "update", state: "{}" },
        android: { priority: "NORMAL", ttl: "3600s", collapse_key: "watch" },
      });
      expect(fake.ofType("alert")).toHaveLength(2);
      expect(fake.ofType("watch")).toHaveLength(1);

      const lines = readFileSync(outboxFile, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      expect(lines[2].message).toEqual({
        token: REQ.token,
        data: { type: "watch", event: "update", state: "{}" },
        android: { priority: "NORMAL", ttl: "3600s", collapse_key: "watch" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
