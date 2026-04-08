import { Command } from "commander";
import { CLI_VERSION } from "./version.js";
import { setJsonMode } from "./output/formatter.js";
import { setColorEnabled } from "./output/colors.js";

import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { whoamiCommand } from "./commands/whoami.js";
import { configCommand } from "./commands/config.js";
import { versionCommand } from "./commands/version.js";
import { taskCommand } from "./commands/task/index.js";
import { repoCommand } from "./commands/repo/index.js";
import { sessionCommand } from "./commands/session/index.js";
import { secretCommand } from "./commands/secret/index.js";
import { workspaceCommand } from "./commands/workspace/index.js";

export function createProgram(): Command {
  const program = new Command("optio")
    .version(CLI_VERSION)
    .description("Optio CLI — terminal-first client for the Optio API")
    .option("--server <url>", "Server URL")
    .option("--api-key <token>", "API key / personal access token")
    .option("--workspace <slug>", "Workspace slug or ID")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable color output")
    .option("--verbose", "Verbose output")
    .hook("preAction", (_thisCommand, actionCommand) => {
      const opts = actionCommand.optsWithGlobals();
      if (opts.json) setJsonMode(true);
      if (opts.color === false) setColorEnabled(false);
    });

  program.addCommand(loginCommand);
  program.addCommand(logoutCommand);
  program.addCommand(whoamiCommand);
  program.addCommand(configCommand);
  program.addCommand(versionCommand);
  program.addCommand(taskCommand);
  program.addCommand(repoCommand);
  program.addCommand(sessionCommand);
  program.addCommand(secretCommand);
  program.addCommand(workspaceCommand);

  return program;
}
