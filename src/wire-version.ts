const MAX_WIRE_VERSION = 31;

export type DecodedWireVersion = {
  version: number;
  payloadBits: number[];
};

/**
 * Prefix-free unary version code, read from left to right:
 * 0 => 0, 1 => 10, 2 => 110, ...
 */
export function encodeWireVersion(version: number): number[] {
  if (!Number.isSafeInteger(version) || version < 0 || version > MAX_WIRE_VERSION) {
    throw new Error(`Invalid wire version: ${version}`);
  }

  return [...Array<number>(version).fill(1), 0];
}

export function decodeWireVersion(bits: number[]): DecodedWireVersion {
  let version = 0;

  while (version < bits.length && bits[version] === 1) {
    version += 1;
    if (version > MAX_WIRE_VERSION) throw new Error("Wire version prefix is too long");
  }

  if (bits[version] !== 0) throw new Error("Unterminated wire version prefix");

  return {
    version,
    payloadBits: bits.slice(version + 1),
  };
}
