/**
 * A workspace with no settings of its own reads the deployment's row (the one
 * with no workspace). Saving one setting there gives the workspace its own
 * row: every setting it didn't touch must keep the value it was reading, not
 * jump back to the built-in default.
 */
import { describe, expect, it } from "vitest";
import { getSettings, upsertSettings } from "./optio-settings-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";

describe("a workspace's first saved setting", () => {
  it("with no deployment row (checked first), starts from the built-in defaults", async () => {
    const ws = (await insertWorkspace()).id;
    const saved = await upsertSettings({ maxTurns: 12 }, ws);
    expect(saved.maxTurns).toBe(12);
    expect(saved.workspaceId).toBe(ws);
  });

  it("keeps the deployment's values for everything else", async () => {
    await upsertSettings(
      {
        systemPrompt: "Deployment additions",
        maxTurns: 30,
        confirmWrites: false,
        defaultReviewAgentType: "codex",
        defaultReviewModel: "gpt-5",
      },
      null,
    );
    const ws = (await insertWorkspace()).id;
    const before = await getSettings(ws);
    expect(before.systemPrompt).toBe("Deployment additions");

    const saved = await upsertSettings({ defaultReviewModel: "gpt-5-mini" }, ws);
    expect(saved.workspaceId).toBe(ws);
    const after = await getSettings(ws);
    expect(after.defaultReviewModel).toBe("gpt-5-mini");
    expect(after.systemPrompt).toBe("Deployment additions");
    expect(after.maxTurns).toBe(30);
    expect(after.confirmWrites).toBe(false);
    expect(after.defaultReviewAgentType).toBe("codex");
    expect(after.agentRuntime).toBe(before.agentRuntime);
    expect(after.model).toBe(before.model);

    // The deployment's row is untouched.
    expect((await getSettings(null)).defaultReviewModel).toBe("gpt-5");
  });
});
