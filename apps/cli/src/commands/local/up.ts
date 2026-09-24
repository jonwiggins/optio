import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { runDaemon } from "../../local/daemon.js";
import { friendlyError } from "../../utils/errors.js";

export const localUpCommand = new Command("up")
  .description("Run the Optio Local daemon (foreground): serve terminals on this machine")
  .option(
    "--no-remote-dirs",
    "Don't let Optio add or remove this machine's directories (use `optio local add|remove` here)",
  )
  .action(async (opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      await runDaemon({ client, remoteDirs: opts.remoteDirs !== false });
    } catch (err) {
      friendlyError(err);
    }
  });
