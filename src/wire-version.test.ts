import { describe, expect, it } from "vitest";
import { decodeWireVersion, encodeWireVersion } from "./wire-version";

describe("unary wire versions", () => {
  it.each([
    [0, [0]],
    [1, [1, 0]],
    [2, [1, 1, 0]],
    [3, [1, 1, 1, 0]],
  ])("encodes version %i", (version, expected) => {
    expect(encodeWireVersion(version)).toEqual(expected);
    expect(decodeWireVersion([...expected, 1, 0, 1])).toEqual({
      version,
      payloadBits: [1, 0, 1],
    });
  });

  it("rejects a prefix without its zero terminator", () => {
    expect(() => decodeWireVersion([1, 1, 1])).toThrow("Unterminated wire version prefix");
  });
});
