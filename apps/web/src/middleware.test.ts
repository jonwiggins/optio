import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to test the middleware function which depends on Next.js server APIs.
// We mock the next/server module and test the logic.

const nextResponseMock = {
  next: vi.fn().mockReturnValue({ type: "next" }),
  redirect: vi.fn().mockReturnValue({ type: "redirect" }),
};

vi.mock("next/server", () => ({
  NextResponse: nextResponseMock,
}));

// Import after mocking
const { middleware } = await import("./middleware");

function createRequest(pathname: string, options?: { cookie?: string; baseUrl?: string }): any {
  const baseUrl = options?.baseUrl ?? "http://localhost:3100";
  const url = new URL(pathname, baseUrl);
  return {
    nextUrl: url,
    url: baseUrl,
    cookies: {
      get: (name: string) => {
        if (name === "optio_session" && options?.cookie) {
          return { value: options.cookie };
        }
        return undefined;
      },
    },
  };
}

describe("middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: auth enabled
    vi.stubEnv("OPTIO_AUTH_DISABLED", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("public paths", () => {
    it("allows /login without session", () => {
      middleware(createRequest("/login"));
      expect(nextResponseMock.next).toHaveBeenCalled();
      expect(nextResponseMock.redirect).not.toHaveBeenCalled();
    });

    it("allows /setup without session", () => {
      middleware(createRequest("/setup"));
      expect(nextResponseMock.next).toHaveBeenCalled();
    });

    it("allows /auth/callback without session", () => {
      middleware(createRequest("/auth/callback"));
      expect(nextResponseMock.next).toHaveBeenCalled();
    });

    it("allows starting a sign-in without session", () => {
      middleware(createRequest("/auth/login/oidc"));
      expect(nextResponseMock.next).toHaveBeenCalled();
      expect(nextResponseMock.redirect).not.toHaveBeenCalled();
    });
  });

  describe("static assets and API", () => {
    it("allows /_next paths", () => {
      middleware(createRequest("/_next/static/chunk.js"));
      expect(nextResponseMock.next).toHaveBeenCalled();
    });

    it("allows /favicon paths", () => {
      middleware(createRequest("/favicon.ico"));
      expect(nextResponseMock.next).toHaveBeenCalled();
    });

    it("allows /api/ proxy routes", () => {
      middleware(createRequest("/api/tasks"));
      expect(nextResponseMock.next).toHaveBeenCalled();
    });

    it("allows paths with file extensions", () => {
      middleware(createRequest("/image.png"));
      expect(nextResponseMock.next).toHaveBeenCalled();
    });
  });

  describe("auth disabled", () => {
    it("allows all paths when auth is disabled", () => {
      vi.stubEnv("OPTIO_AUTH_DISABLED", "true");
      // Re-import to get fresh env read — but since process.env is read at
      // call-time in the middleware, just calling it should work
      middleware(createRequest("/tasks"));
      expect(nextResponseMock.next).toHaveBeenCalled();
      expect(nextResponseMock.redirect).not.toHaveBeenCalled();
    });
  });

  describe("authenticated routes", () => {
    it("redirects to /login when no session cookie on protected route", () => {
      middleware(createRequest("/tasks"));
      expect(nextResponseMock.redirect).toHaveBeenCalled();
      const redirectUrl = nextResponseMock.redirect.mock.calls[0][0];
      expect(redirectUrl.pathname).toBe("/login");
      expect(redirectUrl.searchParams.get("redirect")).toBe("/tasks");
    });

    it("allows access when session cookie is present", () => {
      middleware(createRequest("/tasks", { cookie: "abc123" }));
      expect(nextResponseMock.next).toHaveBeenCalled();
      expect(nextResponseMock.redirect).not.toHaveBeenCalled();
    });

    it("redirects / when no session", () => {
      middleware(createRequest("/"));
      expect(nextResponseMock.redirect).toHaveBeenCalled();
    });

    it("redirects /repos when no session", () => {
      middleware(createRequest("/repos"));
      expect(nextResponseMock.redirect).toHaveBeenCalled();
      const redirectUrl = nextResponseMock.redirect.mock.calls[0][0];
      expect(redirectUrl.searchParams.get("redirect")).toBe("/repos");
    });
  });
});
