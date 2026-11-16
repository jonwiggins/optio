import { existsSync } from "node:fs";
import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { runDaemon } from "../../local/daemon.js";
import { collectDir } from "../../local/flag-dirs.js";
import { friendlyError } from "../../utils/errors.js";

/**
 * Why the daemon can't run on this machine, or null when it can. Its
 * terminals start `$SHELL -l -c <command>` (default /bin/bash), and its agent
 * hooks are sh scripts: native Windows has neither unless SHELL names a
 * shell that exists. WSL is Linux, so the daemon runs there as it does on
 * any Linux machine. The rest of the CLI works on Windows as it is.
 */
export function localUpUnsupported(
  platform: NodeJS.Platform = process.platform,
  shell: string | undefined = process.env.SHELL,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform !== "win32") return null;
  if (shell && exists(shell)) return null;
  return (
    "`optio local up` needs a POSIX shell for its terminals, and native Windows has none. " +
    "Run it inside WSL instead: install the CLI there with install.sh and pair from that shell. " +
    "The other optio commands work here."
  );
}

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
    const unsupported = localUpUnsupported();
    if (unsupported) {
      console.error(unsupported);
      process.exitCode = 1;
      return;
    }
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
