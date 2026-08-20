import { BitReader, BitWriter } from "./bitstream";

export type CanonicalCodebook = {
  readonly lengths: readonly number[];
  bitLength(symbol: number): number;
  write(writer: BitWriter, symbol: number): void;
  read(reader: BitReader): number;
};

const codebookCache = new WeakMap<readonly number[], CanonicalCodebook>();

export function canonicalCodebook(lengths: readonly number[]): CanonicalCodebook {
  const cached = codebookCache.get(lengths);
  if (cached) return cached;
  if (lengths.length < 2 || lengths.some((length) => !Number.isInteger(length) || length < 1 || length > 24)) {
    throw new Error("Canonical Huffman lengths must contain at least two integers between 1 and 24");
  }
  const maximum = Math.max(...lengths);
  const counts = Array.from({ length: maximum + 1 }, () => 0);
  for (const length of lengths) counts[length] += 1;
  const nextCode = Array.from({ length: maximum + 1 }, () => 0);
  let code = 0;
  for (let width = 1; width <= maximum; width += 1) {
    code = (code + (counts[width - 1] ?? 0)) << 1;
    nextCode[width] = code;
  }
  if (code + counts[maximum] !== 1 << maximum) {
    throw new Error("Canonical Huffman lengths do not form a complete prefix code");
  }
  const codes = lengths.map((length) => ({ value: nextCode[length]++, length }));
  const decoding = new Map<string, number>();
  codes.forEach((entry, symbol) => decoding.set(`${entry.length}:${entry.value}`, symbol));

  const codebook: CanonicalCodebook = {
    lengths: [...lengths],
    bitLength(symbol) {
      const length = lengths[symbol];
      if (length === undefined) throw new Error(`Unknown Huffman symbol: ${symbol}`);
      return length;
    },
    write(writer, symbol) {
      const entry = codes[symbol];
      if (!entry) throw new Error(`Unknown Huffman symbol: ${symbol}`);
      writer.write(entry.value, entry.length);
    },
    read(reader) {
      let value = 0;
      for (let length = 1; length <= maximum; length += 1) {
        value = (value << 1) | reader.read(1);
        const symbol = decoding.get(`${length}:${value}`);
        if (symbol !== undefined) return symbol;
      }
      throw new Error("Invalid canonical Huffman code");
    },
  };
  codebookCache.set(lengths, codebook);
  return codebook;
}

export function trainLengthLimitedHuffman(
  frequencies: readonly number[],
  maximumBits = 12,
): number[] {
  if (frequencies.length < 2 || maximumBits < Math.ceil(Math.log2(frequencies.length))) {
    throw new Error("Huffman maximum bit length cannot represent every symbol");
  }
  const weights = frequencies.map((frequency) =>
    Number.isFinite(frequency) && frequency > 0 ? frequency : Number.EPSILON
  );
  const ordered = weights.map((weight, symbol) => ({ weight, symbol }))
    .sort((left, right) => right.weight - left.weight || left.symbol - right.symbol);
  const prefix = [0];
  for (const entry of ordered) prefix.push(prefix.at(-1)! + entry.weight);
  const rangeWeight = (start: number, count: number): number => prefix[start + count] - prefix[start];
  const memo = new Map<string, { cost: number; leaves: number }>();
  const solve = (depth: number, assigned: number, slots: number): number => {
    const key = `${depth}:${assigned}:${slots}`;
    const cached = memo.get(key);
    if (cached) return cached.cost;
    const remaining = ordered.length - assigned;
    if (depth === maximumBits) {
      const cost = remaining === slots ? depth * rangeWeight(assigned, remaining) : Number.POSITIVE_INFINITY;
      memo.set(key, { cost, leaves: remaining });
      return cost;
    }
    let best = { cost: Number.POSITIVE_INFINITY, leaves: 0 };
    for (let leaves = 0; leaves <= Math.min(slots, remaining); leaves += 1) {
      const nextRemaining = remaining - leaves;
      const nextSlots = (slots - leaves) * 2;
      const laterDepths = maximumBits - depth - 1;
      if (nextRemaining < nextSlots || nextRemaining > nextSlots * (2 ** laterDepths)) continue;
      const cost = depth * rangeWeight(assigned, leaves)
        + solve(depth + 1, assigned + leaves, nextSlots);
      if (cost < best.cost) best = { cost, leaves };
    }
    memo.set(key, best);
    return best.cost;
  };
  if (!Number.isFinite(solve(1, 0, 2))) throw new Error("Unable to construct length-limited Huffman code");
  const lengths = Array.from({ length: frequencies.length }, () => maximumBits);
  let depth = 1;
  let assigned = 0;
  let slots = 2;
  while (depth <= maximumBits) {
    const choice = memo.get(`${depth}:${assigned}:${slots}`);
    if (!choice) throw new Error("Missing Huffman optimization state");
    for (let index = 0; index < choice.leaves; index += 1) {
      lengths[ordered[assigned + index].symbol] = depth;
    }
    assigned += choice.leaves;
    slots = (slots - choice.leaves) * 2;
    depth += 1;
  }
  canonicalCodebook(lengths);
  return lengths;
}
