import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  schedules: {
    id: "schedules.id",
    enabled: "schedules.enabled",
    nextRunAt: "schedules.next_run_at",
    createdAt: "schedules.created_at",
  },
  scheduleRuns: {
    id: "schedule_runs.id",
    scheduleId: "schedule_runs.schedule_id",
    triggeredAt: "schedule_runs.triggered_at",
  },
}));

import { db } from "../db/client.js";
import {
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  recordRun,
  getScheduleRuns,
  getDueSchedules,
  markScheduleRan,
  validateCronExpression,
} from "./schedule-service.js";

describe("schedule-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSchedule", () => {
    it("creates a schedule with computed nextRunAt", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "sched-1", ...vals }]) };
        }),
      });

      const result = await createSchedule({
        name: "Daily Build",
        cronExpression: "0 0 * * *",
        taskConfig: {
          title: "Build",
          prompt: "Build the app",
          repoUrl: "https://github.com/o/r",
          agentType: "claude-code",
        },
      });

      expect(capturedValues.name).toBe("Daily Build");
      expect(capturedValues.enabled).toBe(true);
      expect(capturedValues.nextRunAt).toBeInstanceOf(Date);
    });

    it("sets nextRunAt to null when disabled", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "sched-1", ...vals }]) };
        }),
      });

      await createSchedule({
        name: "Disabled",
        cronExpression: "0 0 * * *",
        enabled: false,
        taskConfig: {
          title: "Build",
          prompt: "...",
          repoUrl: "https://github.com/o/r",
          agentType: "claude-code",
        },
      });

      expect(capturedValues.nextRunAt).toBeNull();
    });

    it("passes createdBy to values", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "sched-1" }]) };
        }),
      });

      await createSchedule(
        {
          name: "Test",
          cronExpression: "0 0 * * *",
          taskConfig: {
            title: "T",
            prompt: "P",
            repoUrl: "https://github.com/o/r",
            agentType: "claude-code",
          },
        },
        "user-1",
      );

      expect(capturedValues.createdBy).toBe("user-1");
    });
  });

  describe("listSchedules", () => {
    it("returns all schedules ordered by createdAt", async () => {
      const schedules = [{ id: "s-1" }, { id: "s-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(schedules),
        }),
      });

      const result = await listSchedules();
      expect(result).toEqual(schedules);
    });
  });

  describe("getSchedule", () => {
    it("returns schedule when found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "s-1", name: "Daily" }]),
        }),
      });

      const result = await getSchedule("s-1");
      expect(result).toEqual({ id: "s-1", name: "Daily" });
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getSchedule("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("updateSchedule", () => {
    it("updates schedule and recomputes nextRunAt", async () => {
      // getSchedule mock
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([{ id: "s-1", cronExpression: "0 0 * * *", enabled: true }]),
        }),
      });

      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "s-1", name: "Updated" }]),
            }),
          };
        }),
      });

      const result = await updateSchedule("s-1", { name: "Updated" });
      expect(result!.name).toBe("Updated");
      expect(capturedSet.nextRunAt).toBeInstanceOf(Date);
    });

    it("sets nextRunAt to null when disabling", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([{ id: "s-1", cronExpression: "0 0 * * *", enabled: true }]),
        }),
      });

      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "s-1" }]),
            }),
          };
        }),
      });

      await updateSchedule("s-1", { enabled: false });
      expect(capturedSet.nextRunAt).toBeNull();
    });

    it("returns null when schedule not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await updateSchedule("nonexistent", { name: "X" });
      expect(result).toBeNull();
    });

    it("updates cronExpression and recomputes", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([{ id: "s-1", cronExpression: "0 0 * * *", enabled: true }]),
        }),
      });

      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "s-1" }]),
            }),
          };
        }),
      });

      await updateSchedule("s-1", { cronExpression: "*/5 * * * *" });
      expect(capturedSet.cronExpression).toBe("*/5 * * * *");
      expect(capturedSet.nextRunAt).toBeInstanceOf(Date);
    });
  });

  describe("deleteSchedule", () => {
    it("returns true when deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "s-1" }]),
        }),
      });

      const result = await deleteSchedule("s-1");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await deleteSchedule("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("recordRun", () => {
    it("records a successful run", async () => {
      const run = { id: "run-1", scheduleId: "s-1", taskId: "t-1", status: "success" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([run]),
        }),
      });

      const result = await recordRun("s-1", "t-1", "success");
      expect(result).toEqual(run);
    });

    it("records a failed run with error", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "run-1" }]) };
        }),
      });

      await recordRun("s-1", null, "failed", "Something went wrong");
      expect(capturedValues.error).toBe("Something went wrong");
      expect(capturedValues.taskId).toBeNull();
    });
  });

  describe("getScheduleRuns", () => {
    it("returns runs for a schedule", async () => {
      const runs = [{ id: "r-1" }, { id: "r-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(runs),
            }),
          }),
        }),
      });

      const result = await getScheduleRuns("s-1");
      expect(result).toEqual(runs);
    });
  });

  describe("getDueSchedules", () => {
    it("returns enabled schedules past their nextRunAt", async () => {
      const due = [{ id: "s-1", enabled: true }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(due),
        }),
      });

      const result = await getDueSchedules();
      expect(result).toEqual(due);
    });
  });

  describe("markScheduleRan", () => {
    it("updates lastRunAt and computes new nextRunAt", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      });

      await markScheduleRan("s-1", "0 0 * * *");

      expect(capturedSet.lastRunAt).toBeInstanceOf(Date);
      expect(capturedSet.nextRunAt).toBeInstanceOf(Date);
      expect(capturedSet.nextRunAt.getTime()).toBeGreaterThan(capturedSet.lastRunAt.getTime());
    });
  });

  describe("validateCronExpression", () => {
    it("returns valid for a correct expression", () => {
      const result = validateCronExpression("0 0 * * *");
      expect(result.valid).toBe(true);
      expect(result.nextRun).toBeDefined();
      expect(result.description).toBe("Every day at midnight");
    });

    it("returns invalid for a bad expression", () => {
      const result = validateCronExpression("not a cron");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("describes common cron patterns", () => {
      expect(validateCronExpression("0 9 * * *").description).toBe("Every day at 9:00");
      expect(validateCronExpression("0 0 1 * *").description).toBe(
        "First of every month at midnight",
      );
      expect(validateCronExpression("0 0 * * 1").description).toBe("Every Monday at midnight");
      expect(validateCronExpression("*/5 * * * *").description).toBe("Every hour at minute */5");
      expect(validateCronExpression("0 */2 * * *").description).toBe("Every day at */2:00");
    });

    it("returns raw expression for non-standard patterns", () => {
      const result = validateCronExpression("15 14 1 * 3");
      expect(result.valid).toBe(true);
      expect(result.description).toBe("15 14 1 * 3");
    });
  });
});
