import { Command } from "commander";
import type { LocalHost, LocalTerminal } from "@optio/shared";
import { buildClient } from "../../api/client.js";
import { bold, dim } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { printTable } from "../../output/table.js";
import { friendlyError } from "../../utils/errors.js";

export const localStatusCommand = new Command("status")
  .description("Show local hosts and terminals")
  .action(async (_opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const [{ hosts }, { terminals }] = await Promise.all([
        client.get<{ hosts: LocalHost[] }>("/api/local/hosts"),
        client.get<{ terminals: LocalTerminal[] }>("/api/local/terminals"),
      ]);

      if (isJsonMode()) {
        outputJson({ hosts, terminals });
        return;
      }

      process.stdout.write(bold("Hosts") + "\n");
      if (hosts.length === 0) {
        process.stdout.write(dim("No paired hosts. Run `optio local up` on a machine.") + "\n");
      } else {
        printTable(
          [
            { header: "ID", key: "id", width: 8 },
            { header: "NAME", key: "name" },
            { header: "STATE", key: "state" },
            { header: "DIRS", key: "dirs" },
            { header: "LAST SEEN", key: "lastSeenAt" },
          ],
          hosts.map((h) => ({
            id: h.id.slice(0, 8),
            name: h.name,
            state: h.state,
            dirs: String(h.dirs.length),
            lastSeenAt: h.lastSeenAt ?? "",
          })),
        );
      }

      process.stdout.write("\n" + bold("Terminals") + "\n");
      if (terminals.length === 0) {
        process.stdout.write(dim("No terminals.") + "\n");
        return;
      }
      const hostName = new Map(hosts.map((h) => [h.id, h.name]));
      printTable(
        [
          { header: "ID", key: "id", width: 8 },
          { header: "TITLE", key: "title", width: 30 },
          { header: "STATE", key: "state" },
          { header: "ATTENTION", key: "attention" },
          { header: "HOST", key: "host" },
          { header: "DIR", key: "dir" },
        ],
        terminals.map((t) => ({
          id: t.id.slice(0, 8),
          title: t.title.slice(0, 30),
          state: t.state,
          attention: t.state === "running" ? t.attentionState : "",
          host: hostName.get(t.hostId) ?? t.hostId.slice(0, 8),
          dir: t.dir,
        })),
      );
    } catch (err) {
      friendlyError(err);
    }
  });
