import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { connectWs } from "../../api/ws.js";
import { dim } from "../../output/colors.js";
import { isJsonMode } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const taskLogsCommand = new Command("logs")
  .description("Show task logs")
  .argument("<id>", "Task ID")
  .option("-f, --follow", "Follow log output")
  .option("--type <type>", "Filter by log type")
  .action(async (id, opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);

      if (opts.follow) {
        // Stream via WebSocket
        const wsUrl = client.getWsUrl(`/ws/logs/${id}`);
        const token = client.getToken();

        const ws = connectWs({
          url: wsUrl,
          token,
          onMessage: (data) => {
            try {
              const entry = JSON.parse(data);
              if (opts.type && entry.logType !== opts.type) return;
              if (isJsonMode()) {
                process.stdout.write(data + "\n");
              } else {
                const prefix = dim(`[${entry.logType ?? "log"}] `);
                process.stdout.write(prefix + (entry.content ?? data) + "\n");
              }
            } catch {
              process.stdout.write(data + "\n");
            }
          },
          onClose: () => {
            process.exit(0);
          },
          onError: (err) => {
            process.stderr.write(`WebSocket error: ${err.message}\n`);
          },
        });

        // Handle Ctrl-C gracefully
        process.on("SIGINT", () => {
          ws.close();
          process.exit(0);
        });

        return;
      }

      // Non-follow: fetch existing logs
      const params = new URLSearchParams();
      if (opts.type) params.set("type", opts.type);
      const qs = params.toString();
      const data = await client.get<{ logs: Record<string, string>[] }>(
        `/api/tasks/${id}/logs${qs ? `?${qs}` : ""}`,
      );

      if (isJsonMode()) {
        for (const log of data.logs) {
          process.stdout.write(JSON.stringify(log) + "\n");
        }
        return;
      }

      for (const log of data.logs) {
        const prefix = dim(`[${log.logType ?? "log"}] `);
        process.stdout.write(prefix + (log.content ?? "") + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
