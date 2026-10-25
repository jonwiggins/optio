import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// A webhook's deliveries and controls are its creator's or a workspace
// admin's (apps/api services/webhook-audience.ts, lib/webhook-access.ts);
// anyone else in the workspace still sees the hook itself.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/webhooks/wh-1",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: vi.fn() }));

let currentUserId = "u-member";
let isAdmin = false;
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    userId: currentUserId,
    isAdmin,
    isDeploymentAdmin: false,
    authDisabled: false,
    loaded: true,
  }),
}));

const getWebhook = vi.fn();
const listWebhookDeliveries = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getWebhook: (...a: unknown[]) => getWebhook(...a),
    listWebhookDeliveries: (...a: unknown[]) => listWebhookDeliveries(...a),
  },
}));

import WebhookDetailPage from "./page";

const hook = {
  id: "wh-1",
  url: "https://hooks.example.test/optio",
  events: ["task.completed"],
  description: "Carol's hook",
  secret: null,
  active: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  workspaceId: "ws-1",
  createdBy: "u-carol",
};

const delivery = {
  id: "d-1",
  webhookId: "wh-1",
  event: "task.completed",
  payload: {},
  statusCode: 200,
  responseBody: null,
  success: true,
  attempt: 1,
  error: null,
  deliveredAt: "2026-10-01T00:00:00.000Z",
};

function renderPage() {
  // Already fulfilled, as React's `use` tracks it: the page renders at once.
  const params = Object.assign(Promise.resolve({ id: "wh-1" }), {
    status: "fulfilled",
    value: { id: "wh-1" },
  });
  return render(
    <Suspense fallback={null}>
      <WebhookDetailPage params={params} />
    </Suspense>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUserId = "u-member";
  isAdmin = false;
  getWebhook.mockResolvedValue({ webhook: hook });
});
afterEach(cleanup);

describe("webhook detail page", () => {
  it("shows another member the hook, hides its deliveries and offers no controls", async () => {
    listWebhookDeliveries.mockRejectedValue(
      Object.assign(new Error("Only the webhook's creator or a workspace admin…"), {
        status: 403,
      }),
    );
    renderPage();
    expect(await screen.findByText("Carol's hook")).toBeTruthy();
    expect(screen.getByText("Deliveries hidden")).toBeTruthy();
    expect(screen.queryByText(/Delete/)).toBeNull();
    expect(screen.queryByText(/Disable/)).toBeNull();
    expect(screen.queryByText(/Send test/)).toBeNull();
  });

  it("gives the creator the deliveries and every control", async () => {
    currentUserId = "u-carol";
    listWebhookDeliveries.mockResolvedValue({ deliveries: [delivery] });
    renderPage();
    expect(await screen.findByText("Delivery history")).toBeTruthy();
    expect(screen.getByText(/Delete/)).toBeTruthy();
    expect(screen.getByText(/Disable/)).toBeTruthy();
    expect(screen.getByText(/Send test/)).toBeTruthy();
    expect(screen.queryByText("Deliveries hidden")).toBeNull();
  });

  it("gives a workspace admin the controls on someone else's hook", async () => {
    isAdmin = true;
    listWebhookDeliveries.mockResolvedValue({ deliveries: [] });
    renderPage();
    expect(await screen.findByText(/Delete/)).toBeTruthy();
    expect(screen.getByText("No deliveries yet")).toBeTruthy();
  });

  it("still reports an outage as an error, not as hidden deliveries", async () => {
    listWebhookDeliveries.mockRejectedValue(
      Object.assign(new Error("API error: 500"), { status: 500 }),
    );
    renderPage();
    expect(await screen.findByText("API error: 500")).toBeTruthy();
  });
});
