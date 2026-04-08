import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { printTable } from "../../output/table.js";
import { friendlyError } from "../../utils/errors.js";

export const secretListCommand = new Command("list")
  .description("List secrets")
  .action(async (_opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const data = await client.get<{ secrets: Record<string, string>[] }>("/api/secrets");

      if (isJsonMode()) {
        outputJson(data.secrets);
        return;
      }

      printTable(
        [
          { header: "NAME", key: "name", width: 30 },
          { header: "SCOPE", key: "scope", width: 15 },
        ],
        data.secrets.map((s) => ({
          name: s.name ?? "",
          scope: s.scope ?? "global",
        })),
      );
    } catch (err) {
      friendlyError(err);
    }
  });
