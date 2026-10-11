import { describe, expect, it } from "vitest";

import { validateCitations } from "./citations.js";

describe("validateCitations", () => {
  it("returns an empty array when every citation is valid", () => {
    expect(
      validateCitations(["evidence-1", "evidence-2"], new Set(["evidence-1", "evidence-2"])),
    ).toEqual([]);
  });

  it("returns missing citation ids in input order", () => {
    expect(
      validateCitations(
        ["evidence-3", "evidence-1", "evidence-4"],
        new Set(["evidence-1", "evidence-2"]),
      ),
    ).toEqual(["evidence-3", "evidence-4"]);
  });

  it("preserves duplicate missing citation ids", () => {
    expect(
      validateCitations(["evidence-3", "evidence-3"], new Set(["evidence-1"])),
    ).toEqual(["evidence-3", "evidence-3"]);
  });
});
