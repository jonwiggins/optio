import { describe, it, expect } from "vitest";
import { createProgram } from "../program.js";

describe("CLI command parsing", () => {
  it("creates a program with expected commands", () => {
    const program = createProgram();
    const commandNames = program.commands.map((c) => c.name());

    expect(commandNames).toContain("login");
    expect(commandNames).toContain("logout");
    expect(commandNames).toContain("whoami");
    expect(commandNames).toContain("config");
    expect(commandNames).toContain("version");
    expect(commandNames).toContain("task");
    expect(commandNames).toContain("repo");
    expect(commandNames).toContain("session");
    expect(commandNames).toContain("secret");
    expect(commandNames).toContain("workspace");
  });

  it("task command has expected subcommands", () => {
    const program = createProgram();
    const taskCmd = program.commands.find((c) => c.name() === "task");
    const subNames = taskCmd?.commands.map((c) => c.name()) ?? [];

    expect(subNames).toContain("new");
    expect(subNames).toContain("list");
    expect(subNames).toContain("show");
    expect(subNames).toContain("logs");
    expect(subNames).toContain("cancel");
    expect(subNames).toContain("retry");
    expect(subNames).toContain("review");
    expect(subNames).toContain("message");
  });

  it("repo command has expected subcommands", () => {
    const program = createProgram();
    const repoCmd = program.commands.find((c) => c.name() === "repo");
    const subNames = repoCmd?.commands.map((c) => c.name()) ?? [];

    expect(subNames).toContain("list");
    expect(subNames).toContain("show");
    expect(subNames).toContain("add");
    expect(subNames).toContain("remove");
  });

  it("session command has expected subcommands", () => {
    const program = createProgram();
    const sessionCmd = program.commands.find((c) => c.name() === "session");
    const subNames = sessionCmd?.commands.map((c) => c.name()) ?? [];

    expect(subNames).toContain("new");
    expect(subNames).toContain("list");
    expect(subNames).toContain("attach");
    expect(subNames).toContain("end");
  });

  it("secret command has expected subcommands", () => {
    const program = createProgram();
    const secretCmd = program.commands.find((c) => c.name() === "secret");
    const subNames = secretCmd?.commands.map((c) => c.name()) ?? [];

    expect(subNames).toContain("list");
    expect(subNames).toContain("set");
    expect(subNames).toContain("rm");
  });

  it("workspace command has expected subcommands", () => {
    const program = createProgram();
    const wsCmd = program.commands.find((c) => c.name() === "workspace");
    const subNames = wsCmd?.commands.map((c) => c.name()) ?? [];

    expect(subNames).toContain("list");
    expect(subNames).toContain("switch");
  });

  it("supports global options", () => {
    const program = createProgram();
    const optionNames = program.options.map((o) => o.long);

    expect(optionNames).toContain("--server");
    expect(optionNames).toContain("--api-key");
    expect(optionNames).toContain("--workspace");
    expect(optionNames).toContain("--json");
    expect(optionNames).toContain("--no-color");
    expect(optionNames).toContain("--verbose");
  });
});
