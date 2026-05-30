import {
  ASCII_SYMBOL,
  DATE_DAY_BITS,
  DATE_FORMAT_BITS,
  DATE_MONTH_BITS,
  DATE_YEAR_BASE,
  DATE_YEAR_BITS,
  DATETIME_FORMAT_BITS,
  DICTIONARY,
  EXTENDED_DICTIONARY_BITS,
  MAX_NUMBER_LENGTH,
  MAX_REF_LENGTH,
  MAX_REF_OFFSET,
  MIN_NUMBER_LENGTH,
  MIN_REF_LENGTH,
  NUMBER_SYMBOL,
  REF_SYMBOL,
  TIME_HOUR_BITS,
  TIME_MILLISECOND_BITS,
  TIME_MINUTE_BITS,
  TIME_SECOND_BITS,
  U64_BITS,
  decimalBitWidth,
  dictionarySymbol,
  isExtendedDictionaryId,
  literalSymbol,
} from "./model";

export const DATE_FORMATS = ["slash", "dash", "compact"] as const;
export type DateFormat = typeof DATE_FORMATS[number];

export const DATETIME_FORMATS = ["iso-z", "iso-ms-z", "slug-dash", "compact"] as const;
export type DateTimeFormat = typeof DATETIME_FORMATS[number];

export type Token =
  | { type: "lit"; value: string }
  | { type: "dict"; id: number; value: string }
  | { type: "num"; value: bigint; length: number }
  | { type: "date"; value: string; format: DateFormat; year: number; month: number; day: number }
  | {
      type: "datetime";
      value: string;
      format: DateTimeFormat;
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      second: number;
      millisecond: number;
    }
  | { type: "u64"; value: bigint; length: number }
  | { type: "ref"; offset: number; length: number };

export type TokenizeOptions = {
  useDictionary?: boolean;
  useNumbers?: boolean;
  useReferences?: boolean;
};

const DEFAULT_TOKENIZE_OPTIONS: Required<TokenizeOptions> = {
  useDictionary: true,
  useNumbers: true,
  useReferences: true,
};

const MAX_U64 = (1n << 64n) - 1n;

export function tokenize(source: string, options: TokenizeOptions = {}): Token[] {
  const resolved = { ...DEFAULT_TOKENIZE_OPTIONS, ...options };
  const dictionary = resolved.useDictionary ? dictionaryMatches : () => [];
  const numbers = resolved.useNumbers ? numericMatches : () => [];
  const references = resolved.useReferences ? referencesAt : () => [];
  return tokenizeWithCandidates(source, dictionary, numbers, references);
}

function tokenizeWithCandidates(
  source: string,
  dictionary: (source: string, position: number) => Token[],
  numbers: (source: string, position: number) => Token[],
  references: (source: string, position: number) => Token[],
): Token[] {
  const bestFrom: Array<{ cost: number; tokens: Token[] }> = Array.from({ length: source.length + 1 }, () => ({
    cost: Number.POSITIVE_INFINITY,
    tokens: [],
  }));
  bestFrom[source.length] = { cost: 6, tokens: [] };

  for (let position = source.length - 1; position >= 0; position -= 1) {
    for (const candidate of candidatesAt(source, position, dictionary, numbers, references)) {
      const suffix = bestFrom[nextPosition(candidate, position)];
      const cost = tokenCost(candidate) + suffix.cost;
      const previous = bestFrom[position];

      if (cost < previous.cost) {
        bestFrom[position] = { cost, tokens: [candidate, ...suffix.tokens] };
      }
    }
  }

  return bestFrom[0].tokens;
}

export function materialize(tokens: Token[], seed = ""): string {
  let output = seed;

  for (const token of tokens) {
    if (token.type === "lit") {
      output += token.value;
      continue;
    }

    if (token.type === "dict") {
      output += token.value;
      continue;
    }

    if (token.type === "num") {
      output += token.value.toString().padStart(token.length, "0");
      continue;
    }

    if (token.type === "date" || token.type === "datetime") {
      output += token.value;
      continue;
    }

    if (token.type === "u64") {
      output += token.value.toString();
      continue;
    }

    if (token.offset < 1 || token.offset > output.length) {
      throw new Error(`Invalid reference offset: ${token.offset}`);
    }

    for (let copied = 0; copied < token.length; copied += 1) {
      output += output[output.length - token.offset];
    }
  }

  return output.slice(seed.length);
}

export function tokenCost(token: Token): number {
  if (token.type === "lit") return literalSymbol(token.value) === undefined ? 13 : 6;
  if (token.type === "dict") return isExtendedDictionaryId(token.id) ? 6 + EXTENDED_DICTIONARY_BITS : 6;
  if (token.type === "ref") return 24;
  if (token.type === "date") return 6 + datePayloadBits();
  if (token.type === "datetime") return 6 + dateTimePayloadBits(token.format === "iso-ms-z");
  if (token.type === "u64") return 6 + 6 + U64_BITS;

  return 6 + 6 + decimalBitWidth(token.length);
}

function candidatesAt(
  source: string,
  position: number,
  dictionary: (source: string, position: number) => Token[],
  numbers: (source: string, position: number) => Token[],
  references: (source: string, position: number) => Token[],
): Token[] {
  const char = source[position];
  const candidates: Token[] = [{ type: "lit", value: char }];

  candidates.push(...dictionary(source, position));
  candidates.push(...numbers(source, position));
  candidates.push(...references(source, position));

  return candidates;
}

function dictionaryMatches(source: string, position: number): Token[] {
  const matches: Token[] = [];
  for (let id = 0; id < DICTIONARY.length; id += 1) {
    const value = DICTIONARY[id];
    if (source.startsWith(value, position)) {
      matches.push({ type: "dict", id, value });
    }
  }
  return matches;
}

function nextPosition(token: Token, position: number): number {
  if (token.type === "lit") return position + token.value.length;
  if (token.type === "dict") return position + token.value.length;
  if (token.type === "date" || token.type === "datetime") return position + token.value.length;
  return position + token.length;
}

function numericMatches(source: string, position: number): Token[] {
  return [
    ...dateTimeMatches(source, position),
    ...dateMatches(source, position),
    ...decimalMatches(source, position),
  ];
}

function decimalMatches(source: string, position: number): Token[] {
  let length = 0;

  while (
    length < MAX_NUMBER_LENGTH &&
    position + length < source.length &&
    /\d/.test(source[position + length])
  ) {
    length += 1;
  }

  if (length < MIN_NUMBER_LENGTH) return [];

  const text = source.slice(position, position + length);
  const tokens: Token[] = [{ type: "num", value: BigInt(text), length }];

  const value = BigInt(text);
  if (length >= 16 && length <= 20 && !text.startsWith("0") && value <= MAX_U64) {
    tokens.push({ type: "u64", value, length });
  }

  return tokens;
}

function dateMatches(source: string, position: number): Token[] {
  const matches: Token[] = [];

  const slash = parseDateParts(source.slice(position, position + 10), /^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slash) matches.push({ type: "date", value: source.slice(position, position + 10), format: "slash", ...slash });

  const dash = parseDateParts(source.slice(position, position + 10), /^(\d{4})-(\d{2})-(\d{2})$/);
  if (dash) matches.push({ type: "date", value: source.slice(position, position + 10), format: "dash", ...dash });

  const compact = parseDateParts(source.slice(position, position + 8), /^(\d{4})(\d{2})(\d{2})$/);
  if (compact) matches.push({ type: "date", value: source.slice(position, position + 8), format: "compact", ...compact });

  return matches;
}

function dateTimeMatches(source: string, position: number): Token[] {
  const matches: Token[] = [];
  const isoMs = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z/.exec(source.slice(position, position + 24));
  if (isoMs) {
    const fields = parseDateTimeFields(isoMs);
    if (fields) matches.push({ type: "datetime", value: source.slice(position, position + 24), format: "iso-ms-z", ...fields });
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z/.exec(source.slice(position, position + 20));
  if (iso) {
    const fields = parseDateTimeFields(iso);
    if (fields) matches.push({ type: "datetime", value: source.slice(position, position + 20), format: "iso-z", ...fields });
  }

  const slugDash = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/.exec(source.slice(position, position + 19));
  if (slugDash) {
    const fields = parseDateTimeFields(slugDash);
    if (fields) matches.push({ type: "datetime", value: source.slice(position, position + 19), format: "slug-dash", ...fields });
  }

  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(source.slice(position, position + 14));
  if (compact) {
    const fields = parseDateTimeFields(compact);
    if (fields) matches.push({ type: "datetime", value: source.slice(position, position + 14), format: "compact", ...fields });
  }

  return matches;
}

function parseDateParts(text: string, pattern: RegExp): { year: number; month: number; day: number } | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidDate(year, month, day)) return undefined;

  return { year, month, day };
}

function parseDateTimeFields(match: RegExpExecArray): Omit<Extract<Token, { type: "datetime" }>, "type" | "value" | "format"> | undefined {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = match[7] === undefined ? 0 : Number(match[7]);

  if (!isValidDate(year, month, day)) return undefined;
  if (hour > 23 || minute > 59 || second > 59 || millisecond > 999) return undefined;

  return { year, month, day, hour, minute, second, millisecond };
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (year < DATE_YEAR_BASE || year >= DATE_YEAR_BASE + (1 << DATE_YEAR_BITS)) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function datePayloadBits(): number {
  return 6 + DATE_FORMAT_BITS + DATE_YEAR_BITS + DATE_MONTH_BITS + DATE_DAY_BITS;
}

export function dateTimePayloadBits(hasMilliseconds: boolean): number {
  return datePayloadBits() + DATETIME_FORMAT_BITS - DATE_FORMAT_BITS + TIME_HOUR_BITS + TIME_MINUTE_BITS + TIME_SECOND_BITS + (hasMilliseconds ? TIME_MILLISECOND_BITS : 0);
}

function referencesAt(source: string, position: number): Token[] {
  const searchStart = Math.max(0, position - MAX_REF_OFFSET);
  const refs: Token[] = [];
  const seen = new Set<string>();

  for (let candidate = searchStart; candidate < position; candidate += 1) {
    let length = 0;

    while (
      length < MAX_REF_LENGTH &&
      position + length < source.length &&
      source[candidate + length] === source[position + length]
    ) {
      length += 1;
    }

    for (let refLength = MIN_REF_LENGTH; refLength <= length; refLength += 1) {
      const offset = position - candidate;
      const key = `${offset}:${refLength}`;
      if (seen.has(key)) continue;

      seen.add(key);
      refs.push({ type: "ref", offset, length: refLength });
    }
  }

  return refs.sort((left, right) => {
    if (left.type !== "ref" || right.type !== "ref") return 0;
    return right.length - left.length || left.offset - right.offset;
  });
}

export function tokenSymbol(token: Token): number {
  if (token.type === "lit") return literalSymbol(token.value) ?? ASCII_SYMBOL;
  if (token.type === "dict") return dictionarySymbol(token.id);
  if (["num", "date", "datetime", "u64"].includes(token.type)) return NUMBER_SYMBOL;
  return REF_SYMBOL;
}
