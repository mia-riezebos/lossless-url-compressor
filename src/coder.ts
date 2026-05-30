import { BitReader, BitWriter } from "./bitstream";
import {
  ASCII_SYMBOL,
  DATE_DAY_BITS,
  DATE_FORMAT_BITS,
  DATE_MONTH_BITS,
  DATE_YEAR_BASE,
  DATE_YEAR_BITS,
  DATETIME_FORMAT_BITS,
  END_SYMBOL,
  EXT_DICT_SYMBOL,
  EXTENDED_DICTIONARY_BITS,
  LITERAL_ALPHABET,
  MIN_REF_LENGTH,
  NUMBER_DATE_CODE,
  NUMBER_DATETIME_CODE,
  NUMBER_SYMBOL,
  NUMBER_U64_CODE,
  REF_SYMBOL,
  TIME_HOUR_BITS,
  TIME_MILLISECOND_BITS,
  TIME_MINUTE_BITS,
  TIME_SECOND_BITS,
  U64_BITS,
  decimalBitWidth,
  extendedDictionaryIndex,
  extendedDictionaryValue,
  isExtendedDictionaryId,
  literalSymbol,
  primaryDictionaryValue,
} from "./model";
import { DATETIME_FORMATS, DATE_FORMATS, type DateFormat, type DateTimeFormat, type Token, tokenSymbol } from "./tokenize";

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
      body += readNumberLike(reader);
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
