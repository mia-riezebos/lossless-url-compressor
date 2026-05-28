export class BitWriter {
  readonly bits: number[] = [];

  write(value: number | bigint, width: number): void {
    if (!Number.isInteger(width) || width < 0) {
      throw new Error(`Invalid bit width: ${width}`);
    }

    const bigintValue = BigInt(value);
    if (bigintValue < 0n || bigintValue >= (1n << BigInt(width))) {
      throw new Error(`Value ${value.toString()} does not fit in ${width} bits`);
    }

    for (let shift = width - 1; shift >= 0; shift -= 1) {
      this.bits.push(Number((bigintValue >> BigInt(shift)) & 1n));
    }
  }
}

export class BitReader {
  private position = 0;

  constructor(private readonly bits: number[]) {}

  get done(): boolean {
    return this.position >= this.bits.length;
  }

  read(width: number): number {
    const value = this.readBigInt(width);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Read value exceeds safe integer: ${value}`);
    }

    return Number(value);
  }

  readBigInt(width: number): bigint {
    if (this.position + width > this.bits.length) {
      throw new Error("Unexpected end of bitstream");
    }

    let value = 0n;
    for (let read = 0; read < width; read += 1) {
      value = (value << 1n) | BigInt(this.bits[this.position]);
      this.position += 1;
    }

    return value;
  }
}
