import { describe, expect, it } from "vitest";
import { BitReader, BitWriter } from "./bitstream";
import { canonicalCodebook, trainLengthLimitedHuffman } from "./canonical-huffman";

describe("canonical Huffman module", () => {
  it("roundtrips every symbol through one concatenated bitstream", () => {
    const lengths = trainLengthLimitedHuffman([1000, 500, 100, 10, 1, 1], 4);
    const codebook = canonicalCodebook(lengths);
    const writer = new BitWriter();
    for (const symbol of [0, 1, 2, 3, 4, 5, 0, 2]) codebook.write(writer, symbol);
    const reader = new BitReader(writer.bits);
    expect(Array.from({ length: 8 }, () => codebook.read(reader))).toEqual([0, 1, 2, 3, 4, 5, 0, 2]);
    expect(reader.done).toBe(true);
    expect(codebook.bitLength(0)).toBeLessThan(codebook.bitLength(5));
  });

  it("limits extreme frequency distributions without dropping rare symbols", () => {
    const lengths = trainLengthLimitedHuffman([1e12, ...Array.from({ length: 63 }, () => 1)], 10);
    expect(lengths).toHaveLength(64);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(10);
    expect(() => canonicalCodebook(lengths)).not.toThrow();
  });

  it("rejects incomplete or oversubscribed tables", () => {
    expect(() => canonicalCodebook([1, 2])).toThrow("complete prefix code");
    expect(() => canonicalCodebook([1, 1, 1])).toThrow("complete prefix code");
  });
});
