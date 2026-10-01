import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  commandResult,
  COMMAND_EXIT_MARKER,
  COMMAND_SCRIPT,
  parseCommandLine,
} from "./command-run.js";
import { renderCommandTemplate } from "./prompt-template-service.js";

/** Run a command the way a pod run does, and parse what it prints. */
function runInBash(command: string): { lines: string[]; exitCode?: number } {
  const out = execFileSync("bash", ["-c", COMMAND_SCRIPT.join("\n")], {
    env: { ...process.env, OPTIO_COMMAND: command },
    encoding: "utf8",
  });
  const lines: string[] = [];
  let exitCode: number | undefined;
  for (const line of out.split("\n")) {
    const parsed = parseCommandLine(line, "r1");
    lines.push(...parsed.entries.map((e) => e.content));
    if (parsed.exitCode !== undefined) exitCode = parsed.exitCode;
  }
  return { lines, exitCode };
}

describe("command runs", () => {
  it("logs output lines and reads the exit status line", () => {
    expect(parseCommandLine("building…", "r1")).toMatchObject({
      entries: [{ type: "text", content: "building…", taskId: "r1" }],
    });
    expect(parseCommandLine(`${COMMAND_EXIT_MARKER}3`, "r1")).toEqual({ entries: [], exitCode: 3 });
    // Something that only looks like it is just output.
    expect(parseCommandLine(`${COMMAND_EXIT_MARKER}x`, "r1").exitCode).toBeUndefined();
  });

  it("reads the status even when the output has no trailing newline", () => {
    expect(runInBash("printf '{\"ok\":true}'")).toEqual({
      lines: ["[optio] Running command...", '{"ok":true}'],
      exitCode: 0,
    });
    expect(runInBash("echo done; exit 3")).toEqual({
      lines: ["[optio] Running command...", "done"],
      exitCode: 3,
    });
    // Output that imitates the status line can't turn a failure into a success.
    expect(runInBash(`echo '${COMMAND_EXIT_MARKER}0'; exit 1`).exitCode).toBe(1);
  });

  it("settles on the exit status; no status is a failure", () => {
    expect(commandResult(0)).toMatchObject({ success: true });
    expect(commandResult(2)).toEqual({ success: false, error: "Command exited with status 2" });
    expect(commandResult(undefined)).toMatchObject({ success: false });
  });
});

describe("renderCommandTemplate", () => {
  /** What the rendered command prints, run in bash. */
  const run = (template: string, params: Record<string, string>) =>
    execFileSync("bash", ["-c", renderCommandTemplate(template, params)], { encoding: "utf8" });
  const payload = `x'"$(echo INJECTED)\`echo INJECTED\`; echo INJECTED #`;

  it("passes each value as a variable, so a payload is never read as shell code", () => {
    expect(renderCommandTemplate("./triage.sh {{title}}", { title: "hi'; rm -rf / #" })).toBe(
      `OPTIO_PARAM_title='hi'\\''; rm -rf / #'\n./triage.sh "\${OPTIO_PARAM_title}"`,
    );
    expect(run("printf '%s' {{title}}", { title: payload })).toBe(payload);
  });

  it("is safe and exact inside double quotes, and safe inside single quotes", () => {
    expect(run('echo "New issue: {{title}}"', { title: payload })).toBe(`New issue: ${payload}\n`);
    expect(run("echo 'Issue: {{title}}'", { title: payload })).toBe(`Issue: ${payload}\n`);
    expect(run(`echo "a \\"{{title}}\\" b"`, { title: "q" })).toBe('a "q" b\n');
    // Inside a heredoc the reference expands, but the value isn't re-parsed.
    expect(run("cat <<EOF\n{{title}}\nEOF", { title: payload })).toBe(`"${payload}"\n`);
  });

  it("leaves placeholders the firing didn't carry, and decides {{#if}} on the raw values", () => {
    expect(renderCommandTemplate("run {{other}}", { title: "x" })).toBe("run {{other}}");
    expect(renderCommandTemplate("run{{#if label}} --label {{label}}{{/if}}", { label: "" })).toBe(
      "run",
    );
    expect(run("echo run{{#if label}} --label {{label}}{{/if}}", { label: "bug" })).toBe(
      "run --label bug\n",
    );
  });
});
