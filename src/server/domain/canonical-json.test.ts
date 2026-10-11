import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "./canonical-json.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
  });

  it("produces the same hash regardless of object key order", () => {
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
  });
});
