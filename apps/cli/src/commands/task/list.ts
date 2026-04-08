import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { printTable } from "../../output/table.js";
import { friendlyError } from "../../utils/errors.js";

export const taskListCommand = new Command("list")
  .description("List tasks")
  .option("--state <state>", "Filter by state")
  .option("--repo <url>", "Filter by repo URL")
  .option("--agent <type>", "Filter by agent type")
  .option("--limit <n>", "Max results", parseInt)
  .option("--since <date>", "Tasks created after this date")
  .action(async (opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);

      const params = new URLSearchParams();
      if (opts.state) params.set("state", opts.state);
      if (opts.repo) params.set("repoUrl", opts.repo);
      if (opts.agent) params.set("agentType", opts.agent);
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.since) params.set("since", opts.since);

      const qs = params.toString();
      const data = await client.get<{ tasks: Record<string, string>[] }>(
        `/api/tasks${qs ? `?${qs}` : ""}`,
      );

      if (isJsonMode()) {
        outputJson(data.tasks);
        return;
      }

      printTable(
        [
          { header: "ID", key: "id", width: 8 },
          { header: "STATE", key: "state", width: 16 },
          { header: "TITLE", key: "title", width: 40 },
          { header: "REPO", key: "repoUrl", width: 30 },
        ],
        data.tasks.map((t) => ({
          id: (t.id ?? "").slice(0, 8),
          state: t.state ?? "",
          title: (t.title ?? "").slice(0, 40),
          repoUrl: (t.repoUrl ?? "").replace("https://github.com/", ""),
        })),
      );
    } catch (err) {
      friendlyError(err);
    }
  });
