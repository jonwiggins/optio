import { Command } from "commander";
import { taskNewCommand } from "./new.js";
import { taskListCommand } from "./list.js";
import { taskShowCommand } from "./show.js";
import { taskLogsCommand } from "./logs.js";
import { taskCancelCommand } from "./cancel.js";
import { taskRetryCommand } from "./retry.js";
import { taskReviewCommand } from "./review.js";
import { taskMessageCommand } from "./message.js";

export const taskCommand = new Command("task")
  .description("Manage tasks")
  .addCommand(taskNewCommand)
  .addCommand(taskListCommand)
  .addCommand(taskShowCommand)
  .addCommand(taskLogsCommand)
  .addCommand(taskCancelCommand)
  .addCommand(taskRetryCommand)
  .addCommand(taskReviewCommand)
  .addCommand(taskMessageCommand);
