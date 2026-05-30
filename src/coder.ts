import { BitReader, BitWriter } from "./bitstream";
import {
  ASCII_SYMBOL,
  END_SYMBOL,
  EXT_DICT_SYMBOL,
  EXTENDED_DICTIONARY_BITS,
  LITERAL_ALPHABET,
  MIN_REF_LENGTH,
  NUMBER_SYMBOL,
  REF_SYMBOL,
  decimalBitWidth,
  extendedDictionaryIndex,
  extendedDictionaryValue,
  isExtendedDictionaryId,
  literalSymbol,
  primaryDictionaryValue,
} from "./model";
import { type Token, tokenSymbol } from "./tokenize";

export function encodeTokenStream(tokens: Token[], httpsOmitted: boolean): number[] {
  const writer = new BitWriter();
  writer.write(httpsOmitted ? 0 : 1, 1);

  for (const token of tokens) {
    writer.write(tokenSymbol(token), 6);

    if (token.type === "lit" && literalSymbol(token.value) === undefined) {
      writer.write(token.value.charCodeAt(0), 7);
      continue;
    }

    if (token.type === "dict" && isExtendedDictionaryId(token.id)) {
      writer.write(extendedDictionaryIndex(token.id), EXTENDED_DICTIONARY_BITS);
      continue;
    }

    if (token.type === "num") {
      writer.write(token.length - 1, 6);
      writer.write(token.value, decimalBitWidth(token.length));
      continue;
    }

    if (token.type === "ref") {
      writer.write(token.offset, 12);
      writer.write(token.length - MIN_REF_LENGTH, 6);
    }
  }

  writer.write(END_SYMBOL, 6);
  return writer.bits;
}

export function decodeTokenStream(bits: number[]): { httpsOmitted: boolean; body: string } {
  const reader = new BitReader(bits);
  const httpsOmitted = reader.read(1) === 0;
  let body = "";

  while (!reader.done) {
    const symbol = reader.read(6);

    if (symbol < LITERAL_ALPHABET.length) {
      body += LITERAL_ALPHABET[symbol];
      continue;
    }

    const dictionary = primaryDictionaryValue(symbol);
    if (dictionary !== undefined) {
      body += dictionary;
      continue;
    }

    if (symbol === ASCII_SYMBOL) {
      body += String.fromCharCode(reader.read(7));
      continue;
    }

    if (symbol === NUMBER_SYMBOL) {
      const length = reader.read(6) + 1;
      const value = reader.readBigInt(decimalBitWidth(length));
      body += value.toString().padStart(length, "0");
      continue;
    }

    if (symbol === REF_SYMBOL) {
      const offset = reader.read(12);
      const length = reader.read(6) + MIN_REF_LENGTH;
      if (offset < 1 || offset > body.length) {
        throw new Error(`Invalid reference offset: ${offset}`);
      }

      for (let copied = 0; copied < length; copied += 1) {
        body += body[body.length - offset];
      }
      continue;
    }

    if (symbol === EXT_DICT_SYMBOL) {
      const extended = extendedDictionaryValue(reader.read(EXTENDED_DICTIONARY_BITS));
      if (extended === undefined) throw new Error("Invalid extended dictionary index");
      body += extended;
      continue;
    }

    if (symbol === END_SYMBOL) return { httpsOmitted, body };

    throw new Error(`Invalid token symbol: ${symbol}`);
  }

  throw new Error("Missing end token");
}
