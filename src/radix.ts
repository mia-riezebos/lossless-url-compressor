const MAX_DECODE_BITS = 64 * 1024;

export function encodeBits(bits: number[], alphabet: string): string {
  const bitLength = bits.length;
  const baseNumber = alphabet.length;

  if (bitLength >= baseNumber * baseNumber) {
    throw new Error(`Payload too large for MVP bit-length header: ${bitLength} bits`);
  }

  let value = 0n;
  for (const bit of bits) {
    value = (value << 1n) | BigInt(bit);
  }

  const base = BigInt(baseNumber);
  let digits = "";

  do {
    digits = alphabet[Number(value % base)] + digits;
    value /= base;
  } while (value > 0n);

  return `${alphabet[Math.floor(bitLength / baseNumber)]}${alphabet[bitLength % baseNumber]}${digits}`;
}

export function encodeTerminatedBits(bits: number[], alphabet: string): string {
  let value = 1n;
  for (const bit of bits) {
    value = (value << 1n) | BigInt(bit);
  }

  const base = BigInt(alphabet.length);
  let digits = "";

  do {
    digits = alphabet[Number(value % base)] + digits;
    value /= base;
  } while (value > 0n);

  return digits;
}

export function decodeTerminatedBits(encoded: string, alphabet: string): number[] {
  const base = BigInt(alphabet.length);
  let value = 0n;

  for (const digit of encoded) {
    const index = alphabet.indexOf(digit);
    if (index === -1) throw new Error(`Invalid radix digit: ${digit}`);
    value = value * base + BigInt(index);
  }

  const binary = value.toString(2);
  if (binary.length - 1 > MAX_DECODE_BITS) {
    throw new Error(`Terminated radix payload is too large: ${binary.length - 1} bits`);
  }
  if (binary[0] !== "1") throw new Error("Missing terminated radix sentinel");
  return [...binary.slice(1)].map((bit) => bit === "1" ? 1 : 0);
}

export function decodeBits(encoded: string, alphabet: string): number[] {
  const first = alphabet.indexOf(encoded[0]);
  const second = alphabet.indexOf(encoded[1]);

  if (first === -1 || second === -1) {
    throw new Error("Invalid radix bit-length header");
  }

  const bitLength = first * alphabet.length + second;
  if (bitLength > MAX_DECODE_BITS) {
    throw new Error(`Radix bit-length header is too large: ${bitLength} bits`);
  }
  const base = BigInt(alphabet.length);
  let value = 0n;

  for (const digit of encoded.slice(2)) {
    const index = alphabet.indexOf(digit);
    if (index === -1) throw new Error(`Invalid radix digit: ${digit}`);
    value = value * base + BigInt(index);
  }

  const binary = value.toString(2).padStart(bitLength, "0");
  if (binary.length > bitLength) {
    throw new Error("Radix payload has more bits than declared");
  }

  return [...binary].map((bit) => bit === "1" ? 1 : 0);
}
