import {
  ASCII_SYMBOL,
  DICTIONARY,
  EXTENDED_DICTIONARY_BITS,
  MAX_NUMBER_LENGTH,
  MAX_REF_LENGTH,
  MAX_REF_OFFSET,
  MIN_NUMBER_LENGTH,
  MIN_REF_LENGTH,
  NUMBER_SYMBOL,
  REF_SYMBOL,
  decimalBitWidth,
  dictionarySymbol,
  isExtendedDictionaryId,
  literalSymbol,
} from "./model";

export type Token =
  | { type: "lit"; value: string }
  | { type: "dict"; id: number; value: string }
  | { type: "num"; value: bigint; length: number }
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

export function tokenize(source: string, options: TokenizeOptions = {}): Token[] {
  const resolved = { ...DEFAULT_TOKENIZE_OPTIONS, ...options };
  const dictionary = resolved.useDictionary ? dictionaryMatches : () => [];
  const numbers = resolved.useNumbers ? decimalRun : () => undefined;
  const references = resolved.useReferences ? referencesAt : () => [];
  return tokenizeWithCandidates(source, dictionary, numbers, references);
}

function tokenizeWithCandidates(
  source: string,
  dictionary: (source: string, position: number) => Token[],
  numbers: (source: string, position: number) => Token | undefined,
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

  return 6 + 6 + decimalBitWidth(token.length);
}

function candidatesAt(
  source: string,
  position: number,
  dictionary: (source: string, position: number) => Token[],
  numbers: (source: string, position: number) => Token | undefined,
  references: (source: string, position: number) => Token[],
): Token[] {
  const char = source[position];
  const candidates: Token[] = [{ type: "lit", value: char }];

  candidates.push(...dictionary(source, position));

  const number = numbers(source, position);
  if (number) candidates.push(number);

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
  return position + token.length;
}

function decimalRun(source: string, position: number): Token | undefined {
  let length = 0;

  while (
    length < MAX_NUMBER_LENGTH &&
    position + length < source.length &&
    /\d/.test(source[position + length])
  ) {
    length += 1;
  }

  if (length < MIN_NUMBER_LENGTH) return undefined;

  const text = source.slice(position, position + length);
  return { type: "num", value: BigInt(text), length };
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
  if (token.type === "num") return NUMBER_SYMBOL;
  return REF_SYMBOL;
}
