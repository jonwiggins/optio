import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  workflowTriggers: {
    id: "workflow_triggers.id",
    workflowId: "workflow_triggers.workflow_id",
    type: "workflow_triggers.type",
    config: "workflow_triggers.config",
    paramMapping: "workflow_triggers.param_mapping",
    enabled: "workflow_triggers.enabled",
    createdAt: "workflow_triggers.created_at",
    updatedAt: "workflow_triggers.updated_at",
  },
}));

import { db } from "../db/client.js";
import {
  listTriggers,
  getTrigger,
  createTrigger,
  updateTrigger,
  deleteTrigger,
} from "./workflow-trigger-service.js";

// ─── Helpers ───

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "trig-1",
    workflowId: "wf-1",
    type: "manual",
    config: {},
    paramMapping: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Tests ───

describe("listTriggers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns triggers for a workflow", async () => {
    const rows = [makeDbRow()];
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(rows),
        }),
      }),
    });

    const result = await listTriggers("wf-1");
    expect(result).toEqual(rows);
  });
});

describe("getTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a trigger by id", async () => {
    const row = makeDbRow();
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([row]),
      }),
    });

    const result = await getTrigger("trig-1");
    expect(result).toEqual(row);
  });

  it("returns null when not found", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await getTrigger("nonexistent");
    expect(result).toBeNull();
  });
});

describe("createTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts a new trigger", async () => {
    const row = makeDbRow();

    // Mock the duplicate-type check (select returns empty)
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    (db.insert as any) = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([row]),
      }),
    });

    const result = await createTrigger({
      workflowId: "wf-1",
      type: "manual",
      config: {},
    });

    expect(result).toEqual(row);
  });

  it("throws duplicate_type when type already exists", async () => {
    const existingRow = makeDbRow();

    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([existingRow]),
      }),
    });

    await expect(
      createTrigger({
        workflowId: "wf-1",
        type: "manual",
        config: {},
      }),
    ).rejects.toThrow("duplicate_type");
  });
});

describe("updateTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates a trigger", async () => {
    const updated = makeDbRow({ enabled: false });

    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    (db.update as any) = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      }),
    });

    const result = await updateTrigger("trig-1", { enabled: false });
    expect(result).toEqual(updated);
    expect(result.enabled).toBe(false);
  });

  it("returns null when trigger not found", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    (db.update as any) = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const result = await updateTrigger("nonexistent", { enabled: false });
    expect(result).toBeNull();
  });
});

describe("deleteTrigger", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a trigger and returns true", async () => {
    (db.delete as any) = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([makeDbRow()]),
      }),
    });

    const result = await deleteTrigger("trig-1");
    expect(result).toBe(true);
  });

  it("returns false when trigger not found", async () => {
    (db.delete as any) = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await deleteTrigger("nonexistent");
    expect(result).toBe(false);
  });
});
