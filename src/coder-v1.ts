import { CJK_ALPHABET } from "./alphabet";
import { BitReader, BitWriter } from "./bitstream";
import {
  ASCII_BASE64URL_CODE,
  ASCII_CJK_CODE,
  ASCII_HEX_CODE,
  ASCII_LOWER_HYPHEN_CODE,
  ASCII_PERCENT_CODE,
  ASCII_STRUCTURED_LENGTH_BITS,
  ASCII_SYMBOL,
  ASCII_UNICODE_CODE,
  ASCII_UUID_CODE,
  BASE64URL_ALPHABET,
  DATE_DAY_BITS,
  DATE_FORMAT_BITS,
  DATE_MONTH_BITS,
  DATE_YEAR_BASE,
  DATE_YEAR_BITS,
  DATETIME_FORMAT_BITS,
  END_SYMBOL,
  EXT_DICT_SYMBOL,
  EXTENDED_DICTIONARY_BITS,
  HEX_ALPHABET,
  LITERAL_ALPHABET,
  LOWER_HYPHEN_ALPHABET,
  MIN_REF_LENGTH,
  NUMBER_DATE_CODE,
  NUMBER_DATETIME_CODE,
  NUMBER_SYMBOL,
  NUMBER_U64_CODE,
  REF_LARGE_LENGTH_BITS,
  REF_LARGE_OFFSET_BITS,
  REF_MEDIUM_LENGTH_BITS,
  REF_MEDIUM_OFFSET_BITS,
  REF_SMALL_LENGTH_BITS,
  REF_SMALL_OFFSET_BITS,
  REF_SYMBOL,
  SYMBOL_COUNT,
  TIME_HOUR_BITS,
  TIME_MILLISECOND_BITS,
  TIME_MINUTE_BITS,
  TIME_SECOND_BITS,
  U64_BITS,
  UNICODE_CODE_UNIT_BITS,
  decimalBitWidth,
  extendedDictionaryIndex,
  extendedDictionaryValue,
  isExtendedDictionaryId,
  literalSymbol,
  primaryDictionaryValue,
} from "./model";
import { DATETIME_FORMATS, DATE_FORMATS, type DateFormat, type DateTimeFormat, type Token, tokenSymbol } from "./tokenize";

const FIRST_LITERAL_SYMBOLS = Array.from({ length: 13 }, (_, index) => index);
const SECOND_LITERAL_SYMBOLS = Array.from({ length: 15 }, (_, index) => index + 13);
const V1_PREFERRED_SYMBOLS = [
  ...FIRST_LITERAL_SYMBOLS,
  LITERAL_ALPHABET.length,
  END_SYMBOL,
  REF_SYMBOL,
  ...SECOND_LITERAL_SYMBOLS,
  LITERAL_ALPHABET.length + 1,
] as const;
const V2_PREFERRED_SYMBOLS = [
  EXT_DICT_SYMBOL,
  NUMBER_SYMBOL,
  ASCII_SYMBOL,
  END_SYMBOL,
  REF_SYMBOL,
  ...FIRST_LITERAL_SYMBOLS.slice(0, 11),
] as const;
const V3_PREFERRED_SYMBOLS = [
  REF_SYMBOL,
  EXT_DICT_SYMBOL,
  ASCII_SYMBOL,
  NUMBER_SYMBOL,
  END_SYMBOL,
  7, // /
  12, // .
  0, // e
  1, // a
  3, // t
  8, // s
  9, // n
  10, // c
  11, // l
  13, // m
  14, // w
] as const;

const V1_SYMBOL_ORDER = symbolOrder(V1_PREFERRED_SYMBOLS);
const V2_SYMBOL_ORDER = symbolOrder(V2_PREFERRED_SYMBOLS);
const V3_SYMBOL_ORDER = symbolOrder(V3_PREFERRED_SYMBOLS);
const V1_SYMBOL_RANKS = symbolRanks(V1_SYMBOL_ORDER);
const V2_SYMBOL_RANKS = symbolRanks(V2_SYMBOL_ORDER);
const V3_SYMBOL_RANKS = symbolRanks(V3_SYMBOL_ORDER);

function symbolOrder(preferred: readonly number[]): number[] {
  const uniquePreferred = [...new Set(preferred)];
  return [
    ...uniquePreferred,
    ...Array.from({ length: SYMBOL_COUNT }, (_, symbol) => symbol).filter((symbol) => !uniquePreferred.includes(symbol)),
  ];
}

function symbolRanks(order: number[]): Map<number, number> {
  return new Map(order.map((symbol, rank) => [symbol, rank]));
}

export function encodeTokenStreamV1(tokens: Token[], httpsOmitted: boolean): number[] {
  return encodeTokenStreamWithRanks(tokens, httpsOmitted, V1_SYMBOL_RANKS);
}

export function encodeTokenStreamV2(tokens: Token[], httpsOmitted: boolean): number[] {
  return encodeTokenStreamWithRanks(tokens, httpsOmitted, V2_SYMBOL_RANKS);
}

export function encodeTokenStreamV3(tokens: Token[], httpsOmitted: boolean): number[] {
  return encodeTokenStreamWithRanks(tokens, httpsOmitted, V3_SYMBOL_RANKS);
}

function encodeTokenStreamWithRanks(tokens: Token[], httpsOmitted: boolean, ranks: Map<number, number>): number[] {
  const writer = new BitWriter();
  writer.write(httpsOmitted ? 0 : 1, 1);

  for (const token of tokens) {
    writeTokenSymbol(writer, tokenSymbol(token), ranks);

    if (token.type === "cjk") {
      writeAlphabetRun(writer, ASCII_CJK_CODE, token.value, CJK_ALPHABET);
      continue;
    }

    if (token.type === "hex") {
      writeHex(writer, token.value, token.uppercase);
      continue;
    }

    if (token.type === "uuid") {
      writeUuid(writer, token.value, token.uppercase);
      continue;
    }

    if (token.type === "percent") {
      writePercentRun(writer, token.value, token.uppercase);
      continue;
    }

    if (token.type === "base64url") {
      writeAlphabetRun(writer, ASCII_BASE64URL_CODE, token.value, BASE64URL_ALPHABET);
      continue;
    }

    if (token.type === "lower-hyphen") {
      writeAlphabetRun(writer, ASCII_LOWER_HYPHEN_CODE, token.value, LOWER_HYPHEN_ALPHABET);
      continue;
    }

    if (token.type === "lit" && literalSymbol(token.value) === undefined) {
      writeLiteralEscape(writer, token.value);
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

    if (token.type === "date") {
      writer.write(NUMBER_DATE_CODE, 6);
      writeDate(writer, token);
      continue;
    }

    if (token.type === "datetime") {
      writer.write(NUMBER_DATETIME_CODE, 6);
      writeDateTime(writer, token);
      continue;
    }

    if (token.type === "u64") {
      writer.write(NUMBER_U64_CODE, 6);
      writer.write(token.value, U64_BITS);
      continue;
    }

    if (token.type === "ref") {
      writeReference(writer, token.offset, token.length);
    }
  }

  writeTokenSymbol(writer, END_SYMBOL, ranks);
  return writer.bits;
}

export function decodeTokenStreamV1(bits: number[]): { httpsOmitted: boolean; body: string } {
  return decodeTokenStreamWithOrder(bits, V1_SYMBOL_ORDER);
}

export function decodeTokenStreamV2(bits: number[]): { httpsOmitted: boolean; body: string } {
  return decodeTokenStreamWithOrder(bits, V2_SYMBOL_ORDER);
}

export function decodeTokenStreamV3(bits: number[]): { httpsOmitted: boolean; body: string } {
  return decodeTokenStreamWithOrder(bits, V3_SYMBOL_ORDER);
}

function decodeTokenStreamWithOrder(bits: number[], order: number[]): { httpsOmitted: boolean; body: string } {
  const reader = new BitReader(bits);
  const httpsOmitted = reader.read(1) === 0;
  let body = "";

  while (!reader.done) {
    const symbol = readTokenSymbol(reader, order);

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
      body += readAsciiEscaped(reader);
      continue;
    }

    if (symbol === NUMBER_SYMBOL) {
      body += readNumberLike(reader);
      continue;
    }

    if (symbol === REF_SYMBOL) {
      const { offset, length } = readReference(reader);
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

function writeTokenSymbol(writer: BitWriter, symbol: number, ranks: Map<number, number>): void {
  const rank = ranks.get(symbol);
  if (rank === undefined) throw new Error(`Invalid v1 token symbol: ${symbol}`);

  if (rank < 16) {
    writer.write(0, 1);
    writer.write(rank, 4);
    return;
  }

  if (rank < 32) {
    writer.write(0b10, 2);
    writer.write(rank - 16, 4);
    return;
  }

  if (rank < 48) {
    writer.write(0b110, 3);
    writer.write(rank - 32, 4);
    return;
  }

  writer.write(0b111, 3);
  writer.write(rank - 48, 4);
}

function readTokenSymbol(reader: BitReader, order: number[]): number {
  if (reader.read(1) === 0) return symbolAtRank(reader.read(4), order);
  if (reader.read(1) === 0) return symbolAtRank(16 + reader.read(4), order);
  if (reader.read(1) === 0) return symbolAtRank(32 + reader.read(4), order);
  return symbolAtRank(48 + reader.read(4), order);
}

function symbolAtRank(rank: number, order: number[]): number {
  const symbol = order[rank];
  if (symbol === undefined) throw new Error(`Invalid v1 token rank: ${rank}`);
  return symbol;
}

function writeLiteralEscape(writer: BitWriter, value: string): void {
  const code = value.charCodeAt(0);
  if (code <= 0x7f) {
    writer.write(code, 7);
    return;
  }

  writer.write(ASCII_UNICODE_CODE, 7);
  writer.write(code, UNICODE_CODE_UNIT_BITS);
}

function writeReference(writer: BitWriter, offset: number, length: number): void {
  const encodedLength = length - MIN_REF_LENGTH;

  if (offset < (1 << REF_SMALL_OFFSET_BITS) && encodedLength < (1 << REF_SMALL_LENGTH_BITS)) {
    writer.write(0, 1);
    writer.write(offset, REF_SMALL_OFFSET_BITS);
    writer.write(encodedLength, REF_SMALL_LENGTH_BITS);
    return;
  }

  if (offset < (1 << REF_MEDIUM_OFFSET_BITS) && encodedLength < (1 << REF_MEDIUM_LENGTH_BITS)) {
    writer.write(0b10, 2);
    writer.write(offset, REF_MEDIUM_OFFSET_BITS);
    writer.write(encodedLength, REF_MEDIUM_LENGTH_BITS);
    return;
  }

  writer.write(0b11, 2);
  writer.write(offset, REF_LARGE_OFFSET_BITS);
  writer.write(encodedLength, REF_LARGE_LENGTH_BITS);
}

function readReference(reader: BitReader): { offset: number; length: number } {
  if (reader.read(1) === 0) {
    return {
      offset: reader.read(REF_SMALL_OFFSET_BITS),
      length: reader.read(REF_SMALL_LENGTH_BITS) + MIN_REF_LENGTH,
    };
  }

  if (reader.read(1) === 0) {
    return {
      offset: reader.read(REF_MEDIUM_OFFSET_BITS),
      length: reader.read(REF_MEDIUM_LENGTH_BITS) + MIN_REF_LENGTH,
    };
  }

  return {
    offset: reader.read(REF_LARGE_OFFSET_BITS),
    length: reader.read(REF_LARGE_LENGTH_BITS) + MIN_REF_LENGTH,
  };
}

function writeHex(writer: BitWriter, value: string, uppercase: boolean): void {
  writer.write(ASCII_HEX_CODE, 7);
  writer.write(value.length - 1, ASCII_STRUCTURED_LENGTH_BITS);
  writer.write(uppercase ? 1 : 0, 1);
  writeHexDigits(writer, value);
}

function writeUuid(writer: BitWriter, value: string, uppercase: boolean): void {
  writer.write(ASCII_UUID_CODE, 7);
  writer.write(uppercase ? 1 : 0, 1);
  writeHexDigits(writer, value.replaceAll("-", ""));
}

function writePercentRun(writer: BitWriter, value: string, uppercase: boolean): void {
  writer.write(ASCII_PERCENT_CODE, 7);
  writer.write(value.length / 3 - 1, ASCII_STRUCTURED_LENGTH_BITS);
  writer.write(uppercase ? 1 : 0, 1);

  for (let index = 0; index < value.length; index += 3) {
    writer.write(Number.parseInt(value.slice(index + 1, index + 3), 16), 8);
  }
}

function writeAlphabetRun(writer: BitWriter, code: number, value: string, alphabet: string): void {
  writer.write(code, 7);
  writer.write(value.length - 1, ASCII_STRUCTURED_LENGTH_BITS);

  const width = Math.ceil(Math.log2(alphabet.length));
  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`Character ${char} is not in structured alphabet`);
    writer.write(index, width);
  }
}

function writeHexDigits(writer: BitWriter, value: string): void {
  for (const char of value.toLowerCase()) {
    const index = HEX_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid hex digit: ${char}`);
    writer.write(index, 4);
  }
}

function readAsciiEscaped(reader: BitReader): string {
  const code = reader.read(7);

  if (code === ASCII_HEX_CODE) return readHex(reader);
  if (code === ASCII_UUID_CODE) return readUuid(reader);
  if (code === ASCII_PERCENT_CODE) return readPercentRun(reader);
  if (code === ASCII_BASE64URL_CODE) return readAlphabetRun(reader, BASE64URL_ALPHABET);
  if (code === ASCII_LOWER_HYPHEN_CODE) return readAlphabetRun(reader, LOWER_HYPHEN_ALPHABET);
  if (code === ASCII_CJK_CODE) return readAlphabetRun(reader, CJK_ALPHABET);
  if (code === ASCII_UNICODE_CODE) return String.fromCharCode(reader.read(UNICODE_CODE_UNIT_BITS));

  return String.fromCharCode(code);
}

function readHex(reader: BitReader): string {
  const length = reader.read(ASCII_STRUCTURED_LENGTH_BITS) + 1;
  const uppercase = reader.read(1) === 1;
  return readHexDigits(reader, length, uppercase);
}

function readUuid(reader: BitReader): string {
  const uppercase = reader.read(1) === 1;
  const hex = readHexDigits(reader, 32, uppercase);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readPercentRun(reader: BitReader): string {
  const length = reader.read(ASCII_STRUCTURED_LENGTH_BITS) + 1;
  const uppercase = reader.read(1) === 1;
  let output = "";

  for (let index = 0; index < length; index += 1) {
    output += `%${padHex(reader.read(8), uppercase)}`;
  }

  return output;
}

function readAlphabetRun(reader: BitReader, alphabet: string): string {
  const length = reader.read(ASCII_STRUCTURED_LENGTH_BITS) + 1;
  const width = Math.ceil(Math.log2(alphabet.length));
  let output = "";

  for (let index = 0; index < length; index += 1) {
    const char = alphabet[reader.read(width)];
    if (char === undefined) throw new Error("Invalid structured alphabet index");
    output += char;
  }

  return output;
}

function readHexDigits(reader: BitReader, length: number, uppercase: boolean): string {
  let output = "";

  for (let index = 0; index < length; index += 1) {
    const digit = HEX_ALPHABET[reader.read(4)];
    if (digit === undefined) throw new Error("Invalid hex digit index");
    output += uppercase ? digit.toUpperCase() : digit;
  }

  return output;
}

function padHex(value: number, uppercase: boolean): string {
  const hex = value.toString(16).padStart(2, "0");
  return uppercase ? hex.toUpperCase() : hex;
}

function readNumberLike(reader: BitReader): string {
  const code = reader.read(6);

  if (code === NUMBER_DATE_CODE) return readDate(reader);
  if (code === NUMBER_DATETIME_CODE) return readDateTime(reader);
  if (code === NUMBER_U64_CODE) return reader.readBigInt(U64_BITS).toString();

  const length = code + 1;
  const value = reader.readBigInt(decimalBitWidth(length));
  return value.toString().padStart(length, "0");
}

function writeDate(writer: BitWriter, token: Extract<Token, { type: "date" }>): void {
  writer.write(DATE_FORMATS.indexOf(token.format), DATE_FORMAT_BITS);
  writeDateFields(writer, token.year, token.month, token.day);
}

function writeDateTime(writer: BitWriter, token: Extract<Token, { type: "datetime" }>): void {
  writer.write(DATETIME_FORMATS.indexOf(token.format), DATETIME_FORMAT_BITS);
  writeDateFields(writer, token.year, token.month, token.day);
  writer.write(token.hour, TIME_HOUR_BITS);
  writer.write(token.minute, TIME_MINUTE_BITS);
  writer.write(token.second, TIME_SECOND_BITS);
  if (token.format === "iso-ms-z") writer.write(token.millisecond, TIME_MILLISECOND_BITS);
}

function writeDateFields(writer: BitWriter, year: number, month: number, day: number): void {
  writer.write(year - DATE_YEAR_BASE, DATE_YEAR_BITS);
  writer.write(month, DATE_MONTH_BITS);
  writer.write(day, DATE_DAY_BITS);
}

function readDate(reader: BitReader): string {
  const format = DATE_FORMATS[reader.read(DATE_FORMAT_BITS)];
  if (format === undefined) throw new Error("Invalid date format");

  const fields = readDateFields(reader);
  return formatDate(format, fields.year, fields.month, fields.day);
}

function readDateTime(reader: BitReader): string {
  const format = DATETIME_FORMATS[reader.read(DATETIME_FORMAT_BITS)];
  if (format === undefined) throw new Error("Invalid datetime format");

  const fields = readDateFields(reader);
  const hour = reader.read(TIME_HOUR_BITS);
  const minute = reader.read(TIME_MINUTE_BITS);
  const second = reader.read(TIME_SECOND_BITS);
  const millisecond = format === "iso-ms-z" ? reader.read(TIME_MILLISECOND_BITS) : 0;
  return formatDateTime(format, fields.year, fields.month, fields.day, hour, minute, second, millisecond);
}

function readDateFields(reader: BitReader): { year: number; month: number; day: number } {
  return {
    year: reader.read(DATE_YEAR_BITS) + DATE_YEAR_BASE,
    month: reader.read(DATE_MONTH_BITS),
    day: reader.read(DATE_DAY_BITS),
  };
}

function formatDate(format: DateFormat, year: number, month: number, day: number): string {
  const yyyy = pad(year, 4);
  const mm = pad(month, 2);
  const dd = pad(day, 2);

  if (format === "slash") return `${yyyy}/${mm}/${dd}`;
  if (format === "dash") return `${yyyy}-${mm}-${dd}`;
  return `${yyyy}${mm}${dd}`;
}

function formatDateTime(format: DateTimeFormat, year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number): string {
  const dateDash = formatDate("dash", year, month, day);
  const compactDate = formatDate("compact", year, month, day);
  const hh = pad(hour, 2);
  const mm = pad(minute, 2);
  const ss = pad(second, 2);

  if (format === "iso-z") return `${dateDash}T${hh}:${mm}:${ss}Z`;
  if (format === "iso-ms-z") return `${dateDash}T${hh}:${mm}:${ss}.${pad(millisecond, 3)}Z`;
  if (format === "slug-dash") return `${dateDash}-${hh}-${mm}-${ss}`;
  return `${compactDate}${hh}${mm}${ss}`;
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}
