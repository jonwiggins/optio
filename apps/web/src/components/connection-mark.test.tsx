import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Database, KeyRound, Plug } from "lucide-react";
import { brandIconComponent } from "./brand-icon";
import { ConnectionMark, connectionIconComponent } from "./connection-mark";

describe("connection-mark", () => {
  it("draws a brand's own mark when the icon key is a brand", () => {
    const { container } = render(<ConnectionMark icon="aws" kind="connection" />);
    const tile = container.querySelector("[data-mark]")!;
    expect(tile.getAttribute("data-mark")).toBe("brand:aws");
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    expect(tile.querySelector("svg path")).not.toBeNull();
    expect(connectionIconComponent("PagerDuty")).toBe(brandIconComponent("pagerduty"));
  });

  it("maps generic icon keys to lucide icons", () => {
    expect(connectionIconComponent("database")).toBe(Database);
    expect(connectionIconComponent("postgres", "secret")).toBe(Database);
    const { container } = render(<ConnectionMark icon="database" />);
    expect(container.querySelector("[data-mark]")!.getAttribute("data-mark")).toBe("icon:database");
    expect(container.querySelector("svg.lucide-database")).not.toBeNull();
  });

  it("falls back to the kind's icon, then Plug", () => {
    expect(connectionIconComponent(null, "secret")).toBe(KeyRound);
    expect(connectionIconComponent(undefined, "mcpServer")).toBe(Plug);
    expect(connectionIconComponent("toString")).toBe(Plug);
    expect(connectionIconComponent("nonsense", "connection")).toBe(Plug);
    const { container } = render(<ConnectionMark kind="secret" size="sm" />);
    const tile = container.querySelector("[data-mark]")!;
    expect(tile.getAttribute("data-mark")).toBe("kind:secret");
    expect(tile.querySelector("svg.lucide-key-round")).not.toBeNull();
    expect(tile.getAttribute("class")).toContain("w-5 h-5");
    expect(tile.querySelector("svg")!.getAttribute("class")).toContain("w-3 h-3");
  });

  it("sizes the tile and glyph together", () => {
    const md = render(<ConnectionMark icon="github" />).container.querySelector("[data-mark]")!;
    expect(md.getAttribute("class")).toContain("w-7 h-7");
    expect(md.querySelector("svg")!.getAttribute("class")).toContain("w-4 h-4");
    const lg = render(
      <ConnectionMark icon="github" size="lg" className="ml-1" />,
    ).container.querySelector("[data-mark]")!;
    expect(lg.getAttribute("class")).toContain("w-8 h-8");
    expect(lg.getAttribute("class")).toContain("ml-1");
  });
});
