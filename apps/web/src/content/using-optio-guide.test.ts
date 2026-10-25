import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { USING_OPTIO_GUIDE } from "./using-optio-guide";

describe("the in-app guide", () => {
  it("is docs/using-optio.md (after editing the guide: node apps/web/scripts/sync-guide.mjs)", () => {
    const doc = readFileSync(resolve(__dirname, "../../../../docs/using-optio.md"), "utf8");
    expect(USING_OPTIO_GUIDE).toBe(doc.replace(/\r\n/g, "\n"));
  });
});
