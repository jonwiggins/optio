import { describe, expect, it } from "vitest";
import { commandResult, COMMAND_EXIT_MARKER, parseCommandLine } from "./command-run.js";
import { renderCommandTemplate } from "./prompt-template-service.js";

describe("command runs", () => {
  it("logs output lines and reads the exit status line", () => {
    expect(parseCommandLine("building…", "r1")).toMatchObject({
      entries: [{ type: "text", content: "building…", taskId: "r1" }],
    });
    expect(parseCommandLine(`${COMMAND_EXIT_MARKER}3`, "r1")).toEqual({ entries: [], exitCode: 3 });
    // Something that only looks like it is just output.
    expect(parseCommandLine(`${COMMAND_EXIT_MARKER}x`, "r1").exitCode).toBeUndefined();
  });

  it("settles on the exit status; no status is a failure", () => {
    expect(commandResult(0)).toMatchObject({ success: true });
    expect(commandResult(2)).toEqual({ success: false, error: "Command exited with status 2" });
    expect(commandResult(undefined)).toMatchObject({ success: false });
  });
});

describe("renderCommandTemplate", () => {
  it("shell-quotes every param, so a payload can't inject shell syntax", () => {
    const command = renderCommandTemplate("./triage.sh {{title}}", {
      title: "hi'; rm -rf / #",
    });
    expect(command).toBe(`./triage.sh 'hi'\\''; rm -rf / #'`);
  });

  it("decides {{#if}} on the raw values (a quoted empty string would read as set)", () => {
    expect(renderCommandTemplate("run{{#if label}} --label {{label}}{{/if}}", { label: "" })).toBe(
      "run",
    );
    expect(
      renderCommandTemplate("run{{#if label}} --label {{label}}{{/if}}", { label: "bug" }),
    ).toBe("run --label 'bug'");
  });
});
