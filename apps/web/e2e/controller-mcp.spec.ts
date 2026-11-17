import { expect, test } from "@playwright/test";

import { API } from "./stack-ports";
test("controller access and schedule timezone survive the work form and editing", async ({
  page,
  request,
}) => {
  const name = `Controller settings ${Date.now()}`;
  const created = await request.post(`${API}/api/work`, {
    data: {
      name,
      when: {
        type: "schedule",
        config: { cronExpression: "0 9 * * *", timezone: "America/Denver" },
      },
      where: { runTarget: "cluster" },
      who: { runtime: "claude-code" },
      what: { prompt: "Review results" },
      then: "exits",
      settings: { controllerAccess: "read" },
    },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await page.goto(`/work/${id}/edit`);
  await expect(page.getByRole("heading", { name: /Edit/ })).toBeVisible();
  await expect(page.getByLabel("Schedule timezone")).toHaveValue("America/Denver");
  const environment = page.getByRole("button", { name: /^Environment/ });
  if ((await environment.getAttribute("aria-expanded")) !== "true") await environment.click();
  await expect(page.getByLabel("Optio controller")).toHaveValue("read");
  await page.getByLabel("Optio controller").selectOption("manage");
  await page.getByLabel("Schedule timezone").fill("Asia/Tokyo");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${id}$`));
  const detail = await (await request.get(`${API}/api/work/${id}`)).json();
  expect(detail.work.settings.controllerAccess).toBe("manage");
  const { triggers } = await (await request.get(`${API}/api/work/${id}/triggers`)).json();
  expect(triggers[0].config.timezone).toBe("Asia/Tokyo");
});

test("an existing persistent agent can enable controller tools from Configuration", async ({
  page,
  request,
}) => {
  const res = await request.post(`${API}/api/work`, {
    data: {
      name: "Controller configuration agent",
      when: { type: "manual" },
      where: { runTarget: "cluster" },
      who: { runtime: "claude-code" },
      what: { prompt: "Ready" },
      then: "waits-for-messages",
      agent: { slug: `controller-ui-${Date.now()}`, podLifecycle: "on-demand" },
    },
  });
  expect(res.ok()).toBe(true);
  const { id } = await res.json();
  await page.goto(`/agents/${id}`);
  await page.getByRole("button", { name: /Config/ }).click();
  await page.getByLabel("Optio controller").selectOption("manage");
  await expect(page.getByText("Controller access saved")).toBeVisible();
  const detail = await (await request.get(`${API}/api/persistent-agents/${id}`)).json();
  expect(detail.agent.settings.controllerAccess).toBe("manage");
});

test("MCP through the web endpoint preserves bearer auth and origin protection", async ({
  request,
}) => {
  const data = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const headers = { accept: "application/json, text/event-stream" };
  const result = await request.post("/api/mcp", { headers, data });
  expect(result.status()).toBe(200);
  expect(
    (await result.json()).result.tools.some(
      (t: { name: string }) => t.name === "optio_create_work",
    ),
  ).toBe(true);
  const invalid = await request.post("/api/mcp", {
    headers: { ...headers, authorization: "Bearer invalid" },
    data,
  });
  expect(invalid.status()).toBe(401);
  const foreign = await request.post("/api/mcp", {
    headers: { ...headers, origin: "https://untrusted.example" },
    data,
  });
  expect(foreign.status()).toBe(403);
});
