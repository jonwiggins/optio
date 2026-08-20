import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { runDaemon } from "../../local/daemon.js";
import { friendlyError } from "../../utils/errors.js";

export const localUpCommand = new Command("up")
  .description("Run the Optio Local daemon (foreground): serve terminals on this machine")
  .action(async (_opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      await runDaemon({ client });
    } catch (err) {
      friendlyError(err);
    }
  });
