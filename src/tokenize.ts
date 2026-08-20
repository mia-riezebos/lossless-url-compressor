import { CJK_ALPHABET } from "./alphabet";
import { canonicalCodebook } from "./canonical-huffman";
import {
  ASCII_SYMBOL,
  ASCII_STRUCTURED_LENGTH_BITS,
  BASE64URL_ALPHABET,
  DATE_DAY_BITS,
  DATE_FORMAT_BITS,
  DATE_MONTH_BITS,
  DATE_YEAR_BASE,
  DATE_YEAR_BITS,
  DATETIME_FORMAT_BITS,
  DICTIONARY,
  END_SYMBOL,
  EXTENDED_DICTIONARY_BITS,
  HEX_ALPHABET,
  LOWER_HYPHEN_ALPHABET,
  SHARE_DICTIONARY,
  SHARE_DICTIONARY_BITS,
  V1_SHARE_DICTIONARY_LENGTH,
  V2_ROUTE_SYMBOL,
  MAX_NUMBER_LENGTH,
  MAX_REF_LENGTH,
  MAX_REF_OFFSET,
  MIN_NUMBER_LENGTH,
  MIN_REF_LENGTH,
  NUMBER_SYMBOL,
  REF_MEDIUM_LENGTH_BITS,
  REF_MEDIUM_OFFSET_BITS,
  REF_SMALL_LENGTH_BITS,
  REF_SMALL_OFFSET_BITS,
  REF_SYMBOL,
  TIME_HOUR_BITS,
  TIME_MILLISECOND_BITS,
  TIME_MINUTE_BITS,
  TIME_SECOND_BITS,
  U64_BITS,
  UNICODE_CODE_UNIT_BITS,
  YOUTUBE_VIDEO_ID_LENGTH,
  YOUTUBE_VIDEO_PREFIX_BITS,
  YOUTUBE_VIDEO_PREFIXES,
  decimalBitWidth,
  dictionarySymbol,
  isExtendedDictionaryId,
  literalSymbol,
  v2DictionarySymbol,
  v2ExtendedDictionaryPayloadBits,
} from "./model";
import {
  V2_EXTENDED_DICTIONARY,
  V2_PRIMARY_DICTIONARY,
  V2_SYMBOL_CODE_LENGTHS,
  type V2HeaderModeId,
  type V2RouteAlphabet,
} from "./generated/v2-codec-model";
import { v2HostRoutes, v2RouteAlphabet, v2RouteIdBits } from "./v2-route-model";

export const DATE_FORMATS = ["slash", "dash", "compact"] as const;
export type DateFormat = typeof DATE_FORMATS[number];

export const DATETIME_FORMATS = ["iso-z", "iso-ms-z", "slug-dash", "compact"] as const;
export type DateTimeFormat = typeof DATETIME_FORMATS[number];

export type Token =
  | { type: "lit"; value: string }
  | { type: "cjk"; value: string; length: number }
  | { type: "dict"; id: number; value: string }
  | { type: "v2-dict"; id: number; extended: boolean; value: string }
  | { type: "share"; id: number; value: string }
  | { type: "youtube"; variant: number; id: string; value: string }
  | {
      type: "v2-route";
      id: number;
      idBits: number;
      prefix: string;
      suffix: string;
      suffixAlphabet?: V2RouteAlphabet;
      value: string;
    }
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
  | { type: "hex"; value: string; uppercase: boolean; length: number }
  | { type: "uuid"; value: string; uppercase: boolean; length: number }
  | { type: "percent"; value: string; uppercase: boolean; length: number }
  | { type: "base64url"; value: string; length: number }
  | { type: "lower-hyphen"; value: string; length: number }
  | { type: "ref"; offset: number; length: number };

export type TokenizeOptions = {
  useDictionary?: boolean;
  useNumbers?: boolean;
  useReferences?: boolean;
  useShareDictionary?: boolean;
  useRoutes?: boolean;
};

export type TokenizeContext =
  | { version: "v1" }
  | {
      version: "v2";
      mode: V2HeaderModeId;
      codeLengths?: readonly number[];
      header: { kind: "raw" | "host" | "suffix"; value: string | null };
    };

const DEFAULT_TOKENIZE_OPTIONS: Required<TokenizeOptions> = {
  useDictionary: true,
  useNumbers: true,
  useReferences: true,
  useShareDictionary: true,
  useRoutes: true,
};

const MAX_U64 = (1n << 64n) - 1n;
const V2_DICTIONARY_CANDIDATES = dictionaryCandidatesByFirstCharacter();

export function tokenize(
  source: string,
  options: TokenizeOptions = {},
  context: TokenizeContext = { version: "v1" },
): Token[] {
  const resolved = { ...DEFAULT_TOKENIZE_OPTIONS, ...options };
  const dictionary = resolved.useDictionary
    ? (source: string, position: number) => dictionaryAndStructuredMatches(
        source,
        position,
        resolved.useShareDictionary,
        resolved.useRoutes,
        context,
      )
    : () => [];
  const numbers = resolved.useNumbers ? numericMatches : () => [];
  const references = resolved.useReferences ? referencesAt : () => [];
  const codebook = context.version === "v2"
    ? canonicalCodebook(context.codeLengths ?? V2_SYMBOL_CODE_LENGTHS[context.mode])
    : null;
  return tokenizeWithCandidates(
    source,
    dictionary,
    numbers,
    references,
    codebook ? (token) => codebook.bitLength(tokenSymbol(token)) + tokenPayloadCost(token) : tokenCost,
    codebook?.bitLength(END_SYMBOL) ?? 6,
  );
}

function tokenizeWithCandidates(
  source: string,
  dictionary: (source: string, position: number) => Token[],
  numbers: (source: string, position: number) => Token[],
  references: (source: string, position: number) => Token[],
  costOf: (token: Token) => number,
  endCost: number,
): Token[] {
  const bestFrom: Array<{ cost: number; tokens: Token[] }> = Array.from({ length: source.length + 1 }, () => ({
    cost: Number.POSITIVE_INFINITY,
    tokens: [],
  }));
  bestFrom[source.length] = { cost: endCost, tokens: [] };

  for (let position = source.length - 1; position >= 0; position -= 1) {
    for (const candidate of candidatesAt(source, position, dictionary, numbers, references)) {
      const suffix = bestFrom[nextPosition(candidate, position)];
      const cost = costOf(candidate) + suffix.cost;
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

    if (
      token.type === "dict"
      || token.type === "v2-dict"
      || token.type === "share"
      || token.type === "youtube"
      || token.type === "v2-route"
      || token.type === "cjk"
    ) {
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

    if (
      token.type === "hex" ||
      token.type === "uuid" ||
      token.type === "percent" ||
      token.type === "base64url" ||
      token.type === "lower-hyphen"
    ) {
      output += token.value;
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
  return 6 + tokenPayloadCost(token);
}

function tokenPayloadCost(token: Token): number {
  if (token.type === "lit") return literalPayloadCost(token.value);
  if (token.type === "cjk") return 7 + ASCII_STRUCTURED_LENGTH_BITS + Math.ceil(Math.log2(CJK_ALPHABET.length)) * token.length;
  if (token.type === "dict") return isExtendedDictionaryId(token.id) ? EXTENDED_DICTIONARY_BITS : 0;
  if (token.type === "v2-dict") return token.extended ? v2ExtendedDictionaryPayloadBits(token.id) : 0;
  if (token.type === "share") return 7 + SHARE_DICTIONARY_BITS;
  if (token.type === "youtube") return 7 + YOUTUBE_VIDEO_PREFIX_BITS + YOUTUBE_VIDEO_ID_LENGTH * 6;
  if (token.type === "v2-route") {
    const suffixBits = token.suffixAlphabet
      ? token.suffix.length * Math.ceil(Math.log2(v2RouteAlphabet(token.suffixAlphabet).length))
      : 0;
    return token.idBits + suffixBits;
  }
  if (token.type === "ref") return refPayloadCost(token.offset, token.length);
  if (token.type === "date") return datePayloadBits();
  if (token.type === "datetime") return dateTimePayloadBits(token.format === "iso-ms-z");
  if (token.type === "u64") return 6 + U64_BITS;
  if (token.type === "hex") return 7 + ASCII_STRUCTURED_LENGTH_BITS + 1 + 4 * token.length;
  if (token.type === "uuid") return 7 + 1 + 128;
  if (token.type === "percent") return 7 + ASCII_STRUCTURED_LENGTH_BITS + 1 + 8 * token.length;
  if (token.type === "base64url") return 7 + ASCII_STRUCTURED_LENGTH_BITS + 6 * token.length;
  if (token.type === "lower-hyphen") return 7 + ASCII_STRUCTURED_LENGTH_BITS + 5 * token.length;

  return 6 + decimalBitWidth(token.length);
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

function dictionaryAndStructuredMatches(
  source: string,
  position: number,
  useShareDictionary: boolean,
  useRoutes: boolean,
  context: TokenizeContext,
): Token[] {
  return [
    ...(context.version === "v2" ? v2DictionaryMatches(source, position) : dictionaryMatches(source, position)),
    ...(useRoutes && context.version === "v1" ? routeMatches(source, position) : []),
    ...(useRoutes && context.version === "v2" ? v2RouteMatches(source, position, context) : []),
    ...(useShareDictionary && context.version === "v1" ? shareDictionaryMatches(source, position) : []),
    ...structuredTextMatches(source, position),
  ];
}

function v2RouteMatches(
  source: string,
  position: number,
  context: Extract<TokenizeContext, { version: "v2" }>,
): Token[] {
  const host = context.header.kind === "host" ? context.header.value : null;
  const routes = v2HostRoutes(host);
  const idBits = v2RouteIdBits(routes);
  const matches: Token[] = [];
  routes.forEach((route, id) => {
    if (!source.startsWith(route.value, position)) return;
    if (!route.suffix) {
      matches.push({
        type: "v2-route",
        id,
        idBits,
        prefix: route.value,
        suffix: "",
        value: route.value,
      });
      return;
    }
    const alphabet = v2RouteAlphabet(route.suffix.alphabet);
    const start = position + route.value.length;
    const suffix = source.slice(start, start + route.suffix.length);
    if (suffix.length !== route.suffix.length || [...suffix].some((character) => !alphabet.includes(character))) return;
    const following = source[start + route.suffix.length];
    if (following !== undefined && alphabet.includes(following)) return;
    matches.push({
      type: "v2-route",
      id,
      idBits,
      prefix: route.value,
      suffix,
      suffixAlphabet: route.suffix.alphabet,
      value: `${route.value}${suffix}`,
    });
  });
  return matches;
}

function routeMatches(source: string, position: number): Token[] {
  return youtubeVideoMatches(source, position);
}

function youtubeVideoMatches(source: string, position: number): Token[] {
  const matches: Token[] = [];

  for (let variant = 0; variant < YOUTUBE_VIDEO_PREFIXES.length; variant += 1) {
    const prefix = YOUTUBE_VIDEO_PREFIXES[variant];
    const idStart = position + prefix.length;
    const id = source.slice(idStart, idStart + YOUTUBE_VIDEO_ID_LENGTH);

    if (!source.startsWith(prefix, position) || !isBase64UrlText(id, YOUTUBE_VIDEO_ID_LENGTH)) continue;

    matches.push({ type: "youtube", variant, id, value: `${prefix}${id}` });
  }

  return matches;
}

function shareDictionaryMatches(source: string, position: number): Token[] {
  const matches: Token[] = [];
  for (let id = 0; id < V1_SHARE_DICTIONARY_LENGTH; id += 1) {
    const value = SHARE_DICTIONARY[id];
    if (source.startsWith(value, position)) {
      matches.push({ type: "share", id, value });
    }
  }
  return matches;
}

function v2DictionaryMatches(source: string, position: number): Token[] {
  const primaryLength = V2_PRIMARY_DICTIONARY.length;
  const matches: Token[] = [];
  for (const { id, value } of V2_DICTIONARY_CANDIDATES.get(source[position]) ?? []) {
    if (source.startsWith(value, position)) {
      matches.push({ type: "v2-dict", id, extended: id >= primaryLength, value });
    }
  }
  return matches;
}

function dictionaryCandidatesByFirstCharacter(): ReadonlyMap<string, readonly { id: number; value: string }[]> {
  const candidates = new Map<string, Array<{ id: number; value: string }>>();
  [...V2_PRIMARY_DICTIONARY, ...V2_EXTENDED_DICTIONARY].forEach((value, id) => {
    const entries = candidates.get(value[0]) ?? [];
    entries.push({ id, value });
    candidates.set(value[0], entries);
  });
  return candidates;
}

function structuredTextMatches(source: string, position: number): Token[] {
  return [
    ...cjkRun(source, position),
    ...uuidMatch(source, position),
    ...percentEncodedRun(source, position),
    ...hexRun(source, position),
    ...base64UrlRun(source, position),
    ...lowerHyphenRun(source, position),
  ];
}

function cjkRun(source: string, position: number): Token[] {
  let length = 0;
  while (position + length < source.length && CJK_ALPHABET.includes(source[position + length])) {
    length += 1;
  }

  return length >= 3 ? [{ type: "cjk", value: source.slice(position, position + length), length }] : [];
}

function uuidMatch(source: string, position: number): Token[] {
  const text = source.slice(position, position + 36);
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text)) {
    return [];
  }

  const casing = hexCasing(text.replaceAll("-", ""));
  return casing === undefined ? [] : [{ type: "uuid", value: text, uppercase: casing, length: text.length }];
}

function percentEncodedRun(source: string, position: number): Token[] {
  let cursor = position;
  let bytes = 0;
  let hex = "";

  while (bytes < 64 && source[cursor] === "%" && isHexPair(source, cursor + 1)) {
    hex += source.slice(cursor + 1, cursor + 3);
    cursor += 3;
    bytes += 1;
  }

  if (bytes < 3) return [];

  const casing = hexCasing(hex);
  return casing === undefined ? [] : [{ type: "percent", value: source.slice(position, cursor), uppercase: casing, length: bytes }];
}

function hexRun(source: string, position: number): Token[] {
  const match = /^[0-9a-fA-F]{11,64}/.exec(source.slice(position, position + 64));
  if (!match) return [];

  const casing = hexCasing(match[0]);
  return casing === undefined ? [] : [{ type: "hex", value: match[0], uppercase: casing, length: match[0].length }];
}

function base64UrlRun(source: string, position: number): Token[] {
  const match = /^[A-Za-z0-9_-]{8,64}/.exec(source.slice(position, position + 64));
  return match ? [{ type: "base64url", value: match[0], length: match[0].length }] : [];
}

function isBase64UrlText(value: string, length: number): boolean {
  return value.length === length && /^[A-Za-z0-9_-]+$/.test(value);
}

function lowerHyphenRun(source: string, position: number): Token[] {
  const match = /^[a-z-]{12,64}/.exec(source.slice(position, position + 64));
  return match ? [{ type: "lower-hyphen", value: match[0], length: match[0].length }] : [];
}

function isHexPair(source: string, position: number): boolean {
  return /^[0-9a-fA-F]{2}$/.test(source.slice(position, position + 2));
}

function hexCasing(hex: string): boolean | undefined {
  const hasLower = /[a-f]/.test(hex);
  const hasUpper = /[A-F]/.test(hex);
  if (hasLower && hasUpper) return undefined;
  return hasUpper;
}

function literalPayloadCost(value: string): number {
  if (literalSymbol(value) !== undefined) return 0;
  return value.charCodeAt(0) <= 0x7f ? 7 : 7 + UNICODE_CODE_UNIT_BITS;
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
  if (token.type === "cjk") return position + token.value.length;
  if (token.type === "dict") return position + token.value.length;
  if (token.type === "v2-dict") return position + token.value.length;
  if (token.type === "share") return position + token.value.length;
  if (token.type === "youtube") return position + token.value.length;
  if (token.type === "v2-route") return position + token.value.length;
  if (
    token.type === "date" ||
    token.type === "datetime" ||
    token.type === "hex" ||
    token.type === "uuid" ||
    token.type === "percent" ||
    token.type === "base64url" ||
    token.type === "lower-hyphen"
  ) {
    return position + token.value.length;
  }
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

function refPayloadCost(offset: number, length: number): number {
  const encodedLength = length - MIN_REF_LENGTH;
  if (offset < (1 << REF_SMALL_OFFSET_BITS) && encodedLength < (1 << REF_SMALL_LENGTH_BITS)) {
    return 1 + REF_SMALL_OFFSET_BITS + REF_SMALL_LENGTH_BITS;
  }
  if (offset < (1 << REF_MEDIUM_OFFSET_BITS) && encodedLength < (1 << REF_MEDIUM_LENGTH_BITS)) {
    return 2 + REF_MEDIUM_OFFSET_BITS + REF_MEDIUM_LENGTH_BITS;
  }
  return 2 + 12 + 6;
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
  if (token.type === "cjk") return ASCII_SYMBOL;
  if (token.type === "dict") return dictionarySymbol(token.id);
  if (token.type === "v2-dict") return v2DictionarySymbol(token.id);
  if (token.type === "v2-route") return V2_ROUTE_SYMBOL;
  if (token.type === "share" || token.type === "youtube") return ASCII_SYMBOL;
  if (token.type === "num" || token.type === "date" || token.type === "datetime" || token.type === "u64") return NUMBER_SYMBOL;
  if (
    token.type === "hex" ||
    token.type === "uuid" ||
    token.type === "percent" ||
    token.type === "base64url" ||
    token.type === "lower-hyphen"
  ) return ASCII_SYMBOL;
  return REF_SYMBOL;
}
