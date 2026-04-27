import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { LogLine } from "./log-viewer";

afterEach(cleanup);

const tableMarkdown = ["| Col A | Col B |", "| ----- | ----- |", "| a1    | b1    |"].join("\n");

describe("LogLine (text branch)", () => {
  it("renders text-type content as markdown when no search query is active", () => {
    const { container } = render(
      <LogLine log={{ logType: "text", content: tableMarkdown }} searchQuery="" />,
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("falls back to plain-text rendering with highlight when searchQuery is set", () => {
    const { container } = render(
      <LogLine log={{ logType: "text", content: tableMarkdown }} searchQuery="Col A" />,
    );
    // Markdown table is suppressed so the substring highlighter can wrap matches
    expect(container.querySelector("table")).toBeNull();
    const marks = container.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent).toBe("Col A");
  });

  it("renders default text (no logType) as markdown", () => {
    const { container } = render(
      <LogLine log={{ content: "## A heading\n\nSome **bold** text." }} searchQuery="" />,
    );
    expect(container.querySelector("h2")).not.toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
  });

  it("does not invoke markdown rendering for tool_result entries", () => {
    const { container } = render(
      <LogLine
        log={{ logType: "tool_result", content: "| Col A | Col B |\n| --- | --- |\n| a | b |" }}
        searchQuery=""
      />,
    );
    // tool_result is rendered inside <pre>, never as a real <table>
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
  });
});
