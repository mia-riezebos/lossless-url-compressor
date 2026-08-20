import { describe, expect, it } from "vitest";
import { CJK_ALPHABET, CJK_CLIENT_ALPHABET } from "./alphabet";
import { decodeTerminatedBits, encodeTerminatedBits } from "./radix";

describe("v2 CJK fragment radix", () => {
  it("uses # as one additional client-only digit", () => {
    expect(CJK_CLIENT_ALPHABET.length).toBe(CJK_ALPHABET.length + 1);
    expect(CJK_CLIENT_ALPHABET.at(-1)).toBe("#");
    expect(CJK_ALPHABET).not.toContain("#");

    const value = BigInt(CJK_ALPHABET.length);
    const bits = [...value.toString(2).slice(1)].map((bit) => bit === "1" ? 1 : 0);
    const encoded = encodeTerminatedBits(bits, CJK_CLIENT_ALPHABET);

    expect(encoded).toBe("#");
    expect(decodeTerminatedBits(encoded, CJK_CLIENT_ALPHABET)).toEqual(bits);
  });
});
