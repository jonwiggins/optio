import { Command } from "commander";
import { workspaceListCommand } from "./list.js";
import { workspaceSwitchCommand } from "./switch.js";

export const workspaceCommand = new Command("workspace")
  .description("Manage workspaces")
  .addCommand(workspaceListCommand)
  .addCommand(workspaceSwitchCommand);
