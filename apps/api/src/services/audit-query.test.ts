import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));

import {
  CSV_COLUMNS,
  csvField,
  csvHeader,
  csvRow,
  jsonLine,
  type AuditItem,
} from "./audit-query.js";

const item: AuditItem = {
  id: "a-1",
  time: "2026-10-24T09:12:03.120Z",
  workspaceId: "ws-1",
  workspaceName: "Acme, Inc.",
  actor: { id: "u-1", email: "carol@example.test", name: 'Carol "CJ" Jones' },
  action: "team.join.approve",
  label: "Join request approved",
  success: true,
  clientIp: "10.0.0.5",
  details: { teamId: "t-1", targetUserId: "u-2" },
};

describe("CSV export", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(null)).toBe("");
    expect(csvField(false)).toBe("false");
  });

  it("defuses a cell a spreadsheet would run as a formula", () => {
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-2")).toBe("'-2");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("=a,b")).toBe(`"'=a,b"`);
  });

  it("has a header and one CRLF line per entry, in the header's order", () => {
    expect(csvHeader()).toBe(`${CSV_COLUMNS.join(",")}\r\n`);
    expect(csvRow(item)).toBe(
      [
        "2026-10-24T09:12:03.120Z",
        "ws-1",
        '"Acme, Inc."',
        "u-1",
        "carol@example.test",
        '"Carol ""CJ"" Jones"',
        "team.join.approve",
        "Join request approved",
        "true",
        "10.0.0.5",
        '"{""teamId"":""t-1"",""targetUserId"":""u-2""}"',
      ].join(",") + "\r\n",
    );
  });

  it("leaves the actor and details empty when there are none", () => {
    const row = csvRow({
      ...item,
      workspaceName: "Acme",
      actor: null,
      details: {},
      clientIp: null,
    });
    expect(row.split(",").slice(3, 6)).toEqual(["", "", ""]);
    expect(row.endsWith(",,\r\n")).toBe(true);
  });
});

describe("JSON lines export", () => {
  it("is one parseable object per line", () => {
    const line = jsonLine(item);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual(item);
  });
});
