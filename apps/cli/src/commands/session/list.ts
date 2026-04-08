import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { printTable } from "../../output/table.js";
import { friendlyError } from "../../utils/errors.js";

export const sessionListCommand = new Command("list")
  .description("List interactive sessions")
  .option("--state <state>", "Filter by state (active, ended)")
  .action(async (opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const params = new URLSearchParams();
      if (opts.state) params.set("state", opts.state);
      const qs = params.toString();
      const data = await client.get<{ sessions: Record<string, string>[] }>(
        `/api/sessions${qs ? `?${qs}` : ""}`,
      );

      if (isJsonMode()) {
        outputJson(data.sessions);
        return;
      }

      printTable(
        [
          { header: "ID", key: "id", width: 8 },
          { header: "STATE", key: "state", width: 8 },
          { header: "REPO", key: "repoUrl", width: 30 },
          { header: "BRANCH", key: "branch", width: 20 },
        ],
        data.sessions.map((s) => ({
          id: (s.id ?? "").slice(0, 8),
          state: s.state ?? "",
          repoUrl: (s.repoUrl ?? "").replace("https://github.com/", ""),
          branch: s.branch ?? "",
        })),
      );
    } catch (err) {
      friendlyError(err);
    }
  });
