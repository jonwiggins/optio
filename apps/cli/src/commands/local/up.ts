import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { runDaemon } from "../../local/daemon.js";
import { collectDir } from "../../local/flag-dirs.js";
import { friendlyError } from "../../utils/errors.js";

export const localUpCommand = new Command("up")
  .description("Run the Optio Local daemon (foreground): serve terminals on this machine")
  .option(
    "--no-remote-dirs",
    "Don't let Optio add or remove this machine's directories (use `optio local add|remove` here)",
  )
  .option(
    "--dir <path>",
    "Also offer this directory, for this run only (not written to local.json; repeatable)",
    collectDir,
    [],
  )
  .option("--name <name>", "This machine's name in Optio (default: OPTIO_LOCAL_HOSTNAME)")
  .action(async (opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      await runDaemon({
        client,
        remoteDirs: opts.remoteDirs !== false,
        dirs: opts.dir,
        name: opts.name,
      });
    } catch (err) {
      friendlyError(err);
    }
  });
