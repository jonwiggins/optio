import { describe, expect, it } from "vitest";
import type { WorkEnvironmentEntry } from "@optio/shared";
import {
  entryOwnerScope,
  entryPickReason,
  entrySubtext,
  kindLabel,
  namesSummary,
  ownerWord,
  partsLabel,
} from "./connections";

const entry = (over: Partial<WorkEnvironmentEntry> = {}): WorkEnvironmentEntry => ({
  kind: "connection",
  id: "c",
  name: "Acme Linear",
  parts: ["tools", "credentials"],
  providerName: "Linear",
  enabled: true,
  scope: "workspace",
  default: false,
  ownerUserId: null,
  ownerName: null,
  ...over,
});

describe("connection words", () => {
  it("names the parts in a fixed order, with 'only' for one", () => {
    expect(partsLabel(["credentials", "tools"])).toBe("tools + credentials");
    expect(partsLabel(["credentials"])).toBe("credentials only");
    expect(partsLabel(["note", "env", "credentials"])).toBe("credentials + shell env + note");
    expect(partsLabel([])).toBe("nothing yet");
  });

  it("says what a row is", () => {
    expect(kindLabel(entry())).toBe("Linear");
    expect(kindLabel({ kind: "secret", providerName: null })).toBe("Secret");
    expect(kindLabel({ kind: "mcpServer", providerName: null })).toBe("MCP server");
  });

  it("says whose a row is from the viewer's side, auth disabled included", () => {
    expect(ownerWord(entry(), "jon")).toBe("Organization");
    expect(ownerWord(entry({ ownerUserId: "jon" }), "jon")).toBe("Private");
    expect(ownerWord(entry({ ownerUserId: "sam", ownerName: "Sam" }), "jon")).toBe("Sam's");
    expect(entryOwnerScope(entry({ ownerUserId: "sam" }), null)).toBe("private");
  });

  it("builds the one subtext line", () => {
    expect(entrySubtext(entry({ ownerUserId: "jon" }), "jon")).toBe(
      "Private · tools + credentials · Linear",
    );
  });

  it("explains why a row can't be picked", () => {
    expect(entryPickReason(entry(), "jon", "workspace")).toBeNull();
    expect(entryPickReason(entry({ ownerUserId: "sam", ownerName: "Sam" }), "jon", "me")).toBe(
      "Only Sam's work can use this",
    );
    expect(entryPickReason(entry({ ownerUserId: "jon" }), "jon", "workspace")).toMatch(
      /Switch the owner to Private/,
    );
    expect(entryPickReason(entry({ enabled: false }), "jon", "me")).toMatch(/Disabled/);
  });

  it("summarizes names", () => {
    expect(namesSummary(["a", "b", "c", "d", "e"])).toBe("a, b, c, +2");
    expect(namesSummary(["a"])).toBe("a");
    expect(namesSummary([])).toBe("");
  });
});
