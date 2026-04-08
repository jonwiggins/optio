import { Command } from "commander";
import { sessionNewCommand } from "./new.js";
import { sessionListCommand } from "./list.js";
import { sessionAttachCommand } from "./attach.js";
import { sessionEndCommand } from "./end.js";

export const sessionCommand = new Command("session")
  .description("Manage interactive sessions")
  .addCommand(sessionNewCommand)
  .addCommand(sessionListCommand)
  .addCommand(sessionAttachCommand)
  .addCommand(sessionEndCommand);
