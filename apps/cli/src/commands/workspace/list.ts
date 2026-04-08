import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { printTable } from "../../output/table.js";
import { friendlyError } from "../../utils/errors.js";

export const workspaceListCommand = new Command("list")
  .description("List workspaces")
  .action(async (_opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const data = await client.get<{ workspaces: Record<string, string>[] }>("/api/workspaces");

      if (isJsonMode()) {
        outputJson(data.workspaces);
        return;
      }

      printTable(
        [
          { header: "SLUG", key: "slug", width: 20 },
          { header: "NAME", key: "name", width: 30 },
          { header: "ID", key: "id", width: 8 },
        ],
        data.workspaces.map((w) => ({
          slug: w.slug ?? "",
          name: w.name ?? "",
          id: (w.id ?? "").slice(0, 8),
        })),
      );
    } catch (err) {
      friendlyError(err);
    }
  });
