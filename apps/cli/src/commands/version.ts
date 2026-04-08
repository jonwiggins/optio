import { Command } from "commander";
import { CLI_VERSION } from "../version.js";
import { isJsonMode, outputJson } from "../output/formatter.js";
import { yellow } from "../output/colors.js";

export const versionCommand = new Command("version")
  .description("Show CLI and server versions")
  .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    const result: Record<string, unknown> = { cli: CLI_VERSION };

    // Try to fetch server version
    try {
      const { buildClient } = await import("../api/client.js");
      const client = buildClient(globals);
      const health = await client.get<{ version?: string }>("/api/health");
      result.server = health.version ?? "unknown";
    } catch {
      result.server = "unreachable";
    }

    if (isJsonMode()) {
      outputJson(result);
    } else {
      process.stdout.write(`CLI:    ${CLI_VERSION}\n`);
      if (result.server === "unreachable") {
        process.stdout.write(`Server: ${yellow("unreachable")}\n`);
      } else {
        process.stdout.write(`Server: ${result.server}\n`);
      }
    }
  });
