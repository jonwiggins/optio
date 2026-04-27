import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LogMarkdown } from "./log-markdown";

afterEach(cleanup);

describe("LogMarkdown", () => {
  it("renders plain text inside a paragraph", () => {
    const { container } = render(<LogMarkdown content="hello world" />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
    expect(container.querySelector("p")).not.toBeNull();
  });

  it("renders a GFM table with headers and cells", () => {
    const md = [
      "| Col A | Col B |",
      "| ----- | ----- |",
      "| a1    | b1    |",
      "| a2    | b2    |",
    ].join("\n");
    const { container } = render(<LogMarkdown content={md} />);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    const headers = container.querySelectorAll("th");
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toBe("Col A");
    expect(headers[1].textContent).toBe("Col B");
    const cells = container.querySelectorAll("td");
    expect(cells).toHaveLength(4);
    expect(cells[0].textContent).toBe("a1");
    expect(cells[3].textContent).toBe("b2");
  });

  it("renders a fenced code block inside <pre><code>", () => {
    const md = ["```ts", "const x: number = 1;", "```"].join("\n");
    const { container } = render(<LogMarkdown content={md} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const code = pre!.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain("const x: number = 1;");
  });

  it("renders unordered lists with list items", () => {
    const md = ["- one", "- two", "- three"].join("\n");
    const { container } = render(<LogMarkdown content={md} />);
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.getByText("three")).toBeInTheDocument();
  });

  it("renders links with target=_blank and rel attributes", () => {
    const md = "see [example](https://example.com)";
    render(<LogMarkdown content={md} />);
    const link = screen.getByRole("link", { name: "example" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
    expect(link.getAttribute("rel") ?? "").toContain("noreferrer");
  });

  it("renders inline code wrapped in <code>", () => {
    render(<LogMarkdown content="use `npm install` to set up" />);
    const codeEl = document.querySelector("code");
    expect(codeEl).not.toBeNull();
    expect(codeEl!.textContent).toBe("npm install");
  });

  it("does not render markdown image syntax as <img>", () => {
    const md = "![alt text](https://example.com/foo.png)";
    const { container } = render(<LogMarkdown content={md} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not render raw HTML as DOM (script tag is escaped)", () => {
    const md = "before <script>window.__pwned = true</script> after";
    const { container } = render(<LogMarkdown content={md} />);
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("does not throw on unbalanced / partial markdown (incremental stream)", () => {
    const partial = "Here is a table:\n\n| Col A | Col B |\n| --- | --- |\n| a1 | b";
    expect(() => render(<LogMarkdown content={partial} />)).not.toThrow();
  });

  it("does not throw on an unclosed code fence", () => {
    const partial = "```ts\nconst x = 1;\n// stream cut off mid-fence";
    expect(() => render(<LogMarkdown content={partial} />)).not.toThrow();
  });

  it("renders strikethrough via remark-gfm", () => {
    const { container } = render(<LogMarkdown content="~~obsolete~~" />);
    expect(container.querySelector("del")).not.toBeNull();
  });

  it("forwards className to the wrapping element", () => {
    const { container } = render(<LogMarkdown content="hi" className="my-test-class" />);
    expect(container.firstElementChild?.className).toContain("my-test-class");
  });
});
