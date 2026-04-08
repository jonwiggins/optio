import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { printTable } from "../../output/table.js";
import { friendlyError } from "../../utils/errors.js";

export const repoListCommand = new Command("list")
  .description("List repositories")
  .action(async (_opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const data = await client.get<{ repos: Record<string, string>[] }>("/api/repos");

      if (isJsonMode()) {
        outputJson(data.repos);
        return;
      }

      printTable(
        [
          { header: "ID", key: "id", width: 8 },
          { header: "NAME", key: "fullName", width: 30 },
          { header: "PRESET", key: "imagePreset", width: 10 },
          { header: "CONCURRENCY", key: "maxConcurrentTasks", width: 12 },
        ],
        data.repos.map((r) => ({
          id: (r.id ?? "").slice(0, 8),
          fullName: r.fullName ?? r.repoUrl ?? "",
          imagePreset: r.imagePreset ?? "auto",
          maxConcurrentTasks: r.maxConcurrentTasks ?? "2",
        })),
      );
    } catch (err) {
      friendlyError(err);
    }
  });
