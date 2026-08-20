import { decodeBodyTokenStreamV2, encodeBodyTokenStreamV2 } from "./coder-v1";
import {
  V2_CODEC_MODEL_HASH,
  V2_HEADER_TABLES,
  V2_STRUCTURAL_STATES,
  type GeneratedHeaderEntry,
  type GeneratedHeaderTable,
  type V2HeaderModeId,
} from "./generated/v2-codec-model";
import type { NormalizedUrl } from "./normalize";
import { END_SYMBOL } from "./model";
import { decodeTerminatedBits, encodeTerminatedBits } from "./radix";
import { type TokenizeOptions, tokenize, tokenSymbol } from "./tokenize";
import { decodeWireVersion, encodeWireVersion } from "./wire-version";

const V2_WIRE_VERSION = 0;
const RESERVED_ROUTE_PREFIXES = ["1/", "api/", "assets/", "cdn-cgi/", "favicon.ico", "sw.js"];

type HeaderEntry = {
  kind: "host" | "suffix";
  value: string;
};

type HeaderLocation = {
  tier: 1 | 2 | 3;
  index: number;
  entry: HeaderEntry;
  order: number;
};

type HeaderIndex = {
  hosts: ReadonlyMap<string, HeaderLocation>;
  suffixes: ReadonlyMap<string, HeaderLocation>;
};

type UrlParts = {
  scheme: "http" | "https";
  authority: string;
  tail: string;
  compactableHost: string | null;
};

type Candidate = {
  payload: string;
  headerCharacters: number;
  escaped: boolean;
  location: HeaderLocation | null;
  structure: number;
  order: number;
  symbols: number[];
};

export type V2HeaderSelection = {
  characters: number;
  escaped: boolean;
  selector: "raw" | "host" | "suffix";
  value: string | null;
  modelHash: string;
};

export type EncodedV2Payload = {
  payload: string;
  header: V2HeaderSelection;
  symbols: readonly number[];
};

const indexCache = new Map<V2HeaderModeId, HeaderIndex>();

export function encodeV2Payload(
  normalized: NormalizedUrl,
  alphabet: string,
  modeId: V2HeaderModeId,
  tokenizerOptions: TokenizeOptions = {},
  codeLengths?: readonly number[],
): EncodedV2Payload {
  const table = checkedTable(modeId, alphabet);
  const parts = splitNormalizedUrl(normalized);
  const index = headerIndex(table);
  const candidates: Candidate[] = [];
  let order = 0;

  for (const hostVariant of hostVariants(parts, index)) {
    for (const fileVariant of fileVariants(parts.tail)) {
      const structure = (parts.scheme === "https" ? 1 : 0)
        | (hostVariant.www ? 1 << 1 : 0)
        | (fileVariant.fileCode << 2);
      const residual = `${hostVariant.residualAuthority}${fileVariant.tail}`;
      const tokens = tokenize(residual, tokenizerOptions, {
        version: "v2",
        mode: modeId,
        codeLengths,
        header: {
          kind: hostVariant.location?.entry.kind ?? "raw",
          value: hostVariant.location?.entry.value ?? null,
        },
      });
      const bodyBits = [
        ...encodeWireVersion(V2_WIRE_VERSION),
        ...encodeBodyTokenStreamV2(tokens, modeId, codeLengths),
      ];
      const body = encodeTerminatedBits(bodyBits, alphabet);
      const header = encodeHeader(table, alphabet, hostVariant.location, structure);
      const rawPayload = `${header}${body}`;
      const payload = escapeUnsafePathSurface(rawPayload, table, alphabet, modeId);
      candidates.push({
        payload,
        headerCharacters: [...header].length,
        escaped: payload !== rawPayload,
        location: hostVariant.location,
        structure,
        order,
        symbols: [...tokens.map(tokenSymbol), END_SYMBOL],
      });
      order += 1;
    }
  }

  candidates.sort(compareCandidates);
  const best = candidates[0];
  if (!best) throw new Error("v2 encoder produced no header candidate");
  return {
    payload: best.payload,
    header: {
      characters: best.headerCharacters + (best.escaped ? 1 : 0),
      escaped: best.escaped,
      selector: best.location?.entry.kind ?? "raw",
      value: best.location?.entry.value ?? null,
      modelHash: V2_CODEC_MODEL_HASH,
    },
    symbols: best.symbols,
  };
}

export function decodeV2Payload(
  payload: string,
  alphabet: string,
  modeId: V2HeaderModeId,
): string {
  const table = checkedTable(modeId, alphabet);
  const decodedHeader = decodeHeader(payload, table, alphabet);
  const bodySurface = [...payload].slice(decodedHeader.consumed).join("");
  if (!bodySurface) throw new Error("Missing v2 payload body");
  const framed = decodeWireVersion(decodeTerminatedBits(bodySurface, alphabet));
  if (framed.version !== V2_WIRE_VERSION) {
    throw new Error(`Unsupported wire version: ${framed.version}`);
  }
  const residual = decodeBodyTokenStreamV2(
    framed.payloadBits,
    decodedHeader.location?.entry.kind === "host" ? decodedHeader.location.entry.value : null,
    modeId,
  );
  return restoreUrl(residual, decodedHeader.location?.entry ?? null, decodedHeader.structure);
}

function splitNormalizedUrl(normalized: NormalizedUrl): UrlParts {
  if (normalized.scheme !== "http" && normalized.scheme !== "https") {
    throw new Error("v2 supports only absolute HTTP and HTTPS URLs");
  }
  const prefix = `${normalized.scheme}://`;
  if (!normalized.normalizedUrl.startsWith(prefix)) {
    throw new Error("Normalized URL scheme mismatch");
  }
  const rest = normalized.normalizedUrl.slice(prefix.length);
  const boundary = rest.search(/[/?#]/);
  const authority = boundary === -1 ? rest : rest.slice(0, boundary);
  const tail = boundary === -1 ? "" : rest.slice(boundary);
  return {
    scheme: normalized.scheme,
    authority,
    tail,
    compactableHost: compactableHost(authority),
  };
}

function compactableHost(authority: string): string | null {
  if (!authority || authority.includes("@") || authority.startsWith("[") || /:\d+$/.test(authority)) {
    return null;
  }
  return authority;
}

function hostVariants(parts: UrlParts, index: HeaderIndex): Array<{
  location: HeaderLocation | null;
  residualAuthority: string;
  www: boolean;
}> {
  const variants: Array<{
    location: HeaderLocation | null;
    residualAuthority: string;
    www: boolean;
  }> = [{ location: null, residualAuthority: parts.authority, www: false }];
  if (!parts.compactableHost) return variants;

  const forms = [{ host: parts.compactableHost, www: false }];
  if (parts.compactableHost.startsWith("www.") && parts.compactableHost.length > 4) {
    forms.push({ host: parts.compactableHost.slice(4), www: true });
  }

  for (const form of forms) {
    if (form.www) variants.push({ location: null, residualAuthority: form.host, www: true });
    const labels = form.host.split(".");
    for (let start = 0; start < labels.length; start += 1) {
      const value = labels.slice(start).join(".");
      const host = index.hosts.get(value);
      if (host && (form.host === value || form.host.endsWith(`.${value}`))) {
        variants.push({
          location: host,
          residualAuthority: form.host.slice(0, form.host.length - value.length),
          www: form.www,
        });
      }
      const suffix = index.suffixes.get(value);
      if (suffix && form.host.endsWith(`.${value}`)) {
        variants.push({
          location: suffix,
          residualAuthority: form.host.slice(0, -(value.length + 1)),
          www: form.www,
        });
      }
    }
  }
  return variants;
}

function fileVariants(tail: string): Array<{ tail: string; fileCode: number }> {
  const variants = [{ tail, fileCode: 0 }];
  const suffixStart = tail.search(/[?#]/);
  const pathEnd = suffixStart === -1 ? tail.length : suffixStart;
  const path = tail.slice(0, pathEnd);
  const suffix = tail.slice(pathEnd);
  for (const [file, fileCode] of [["index.html", 1], ["index.php", 2]] as const) {
    if (path.endsWith(`/${file}`)) {
      variants.push({ tail: `${path.slice(0, -file.length)}${suffix}`, fileCode });
    }
  }
  return variants;
}

function encodeHeader(
  table: GeneratedHeaderTable,
  alphabet: string,
  location: HeaderLocation | null,
  structure: number,
): string {
  if (structure < 0 || structure >= V2_STRUCTURAL_STATES) {
    throw new Error(`Invalid v2 structural state: ${structure}`);
  }
  if (!location) return alphabet[structure];
  const packed = location.index * V2_STRUCTURAL_STATES + structure;
  if (location.tier === 1) {
    return alphabet[(location.index + 1) * V2_STRUCTURAL_STATES + structure];
  }
  if (location.tier === 2) {
    const first = table.tier1LeadStates + Math.floor(packed / table.base);
    return `${alphabet[first]}${alphabet[packed % table.base]}`;
  }
  const first = table.tier1LeadStates + table.tier2LeadStates
    + Math.floor(packed / (table.base * table.base));
  const remainder = packed % (table.base * table.base);
  return `${alphabet[first]}${alphabet[Math.floor(remainder / table.base)]}${alphabet[remainder % table.base]}`;
}

function decodeHeader(payload: string, table: GeneratedHeaderTable, alphabet: string): {
  consumed: number;
  location: HeaderLocation | null;
  structure: number;
} {
  const digits = [...payload];
  if (!digits.length) throw new Error("Missing v2 header");
  let offset = 0;
  let first = digitIndex(digits[offset], alphabet);
  if (first === table.base - 1) {
    offset += 1;
    if (offset >= digits.length) throw new Error("Truncated generic v2 header escape");
    first = digitIndex(digits[offset], alphabet);
  }
  if (first < table.tier1LeadStates) {
    const selector = Math.floor(first / V2_STRUCTURAL_STATES);
    const structure = first % V2_STRUCTURAL_STATES;
    return {
      consumed: offset + 1,
      location: selector === 0 ? null : locationAt(table, 1, selector - 1),
      structure: checkedStructure(structure),
    };
  }
  const tier2Start = table.tier1LeadStates;
  const tier3Start = tier2Start + table.tier2LeadStates;
  if (first < tier3Start) {
    const second = digitIndex(requiredDigit(digits, offset + 1), alphabet);
    const packed = (first - tier2Start) * table.base + second;
    const entry = Math.floor(packed / V2_STRUCTURAL_STATES);
    return {
      consumed: offset + 2,
      location: locationAt(table, 2, entry),
      structure: checkedStructure(packed % V2_STRUCTURAL_STATES),
    };
  }
  const tier3End = tier3Start + table.tier3LeadStates;
  if (first < tier3End) {
    const second = digitIndex(requiredDigit(digits, offset + 1), alphabet);
    const third = digitIndex(requiredDigit(digits, offset + 2), alphabet);
    const packed = (first - tier3Start) * table.base * table.base + second * table.base + third;
    const entry = Math.floor(packed / V2_STRUCTURAL_STATES);
    return {
      consumed: offset + 3,
      location: locationAt(table, 3, entry),
      structure: checkedStructure(packed % V2_STRUCTURAL_STATES),
    };
  }
  throw new Error(`Invalid or unused v2 header lead: ${first}`);
}

function restoreUrl(residual: string, entry: HeaderEntry | null, structure: number): string {
  const boundary = residual.search(/[/?#]/);
  const residualAuthority = boundary === -1 ? residual : residual.slice(0, boundary);
  let tail = boundary === -1 ? "" : residual.slice(boundary);
  let authority: string;
  if (!entry) {
    if (!residualAuthority) throw new Error("Raw v2 header requires an authority");
    authority = residualAuthority;
  } else if (entry.kind === "host") {
    if (residualAuthority && !residualAuthority.endsWith(".")) {
      throw new Error("Residual subdomain must end with a dot");
    }
    authority = `${residualAuthority}${entry.value}`;
  } else {
    if (!residualAuthority) throw new Error("Suffix v2 header requires a residual host label");
    authority = `${residualAuthority}.${entry.value}`;
  }

  if ((structure & 0b10) !== 0) {
    authority = `www.${authority}`;
  }
  const fileCode = structure >> 2;
  if (fileCode !== 0) {
    const file = fileCode === 1 ? "index.html" : fileCode === 2 ? "index.php" : null;
    if (!file) throw new Error(`Reserved v2 final-file state: ${fileCode}`);
    const suffixStart = tail.search(/[?#]/);
    const pathEnd = suffixStart === -1 ? tail.length : suffixStart;
    const path = tail.slice(0, pathEnd);
    if (!path.endsWith("/")) throw new Error("Final-file v2 state requires a trailing path slash");
    tail = `${path}${file}${tail.slice(pathEnd)}`;
  }
  return `${(structure & 1) === 1 ? "https" : "http"}://${authority}${tail}`;
}

function headerIndex(table: GeneratedHeaderTable): HeaderIndex {
  const cached = indexCache.get(table.id);
  if (cached) return cached;
  const hosts = new Map<string, HeaderLocation>();
  const suffixes = new Map<string, HeaderLocation>();
  let order = 0;
  for (const [tier, entries] of [[1, table.tier1], [2, table.tier2], [3, table.tier3]] as const) {
    entries.forEach((encoded, index) => {
      const entry = decodeGeneratedEntry(encoded);
      const location = { tier, index, entry, order };
      const target = entry.kind === "host" ? hosts : suffixes;
      if (target.has(entry.value)) throw new Error(`Duplicate ${entry.kind} header entry: ${entry.value}`);
      target.set(entry.value, location);
      order += 1;
    });
  }
  const built = { hosts, suffixes };
  indexCache.set(table.id, built);
  return built;
}

function locationAt(
  table: GeneratedHeaderTable,
  tier: 1 | 2 | 3,
  entryIndex: number,
): HeaderLocation {
  const encoded = table[`tier${tier}`][entryIndex];
  if (!encoded) throw new Error(`Unused v2 tier-${tier} packed state: ${entryIndex}`);
  const order = entryIndex
    + (tier >= 2 ? table.tier1.length : 0)
    + (tier >= 3 ? table.tier2.length : 0);
  return { tier, index: entryIndex, entry: decodeGeneratedEntry(encoded), order };
}

function decodeGeneratedEntry(encoded: GeneratedHeaderEntry): HeaderEntry {
  return encoded.startsWith("h:")
    ? { kind: "host", value: encoded.slice(2) }
    : { kind: "suffix", value: encoded.slice(2) };
}

function checkedTable(modeId: V2HeaderModeId, alphabet: string): GeneratedHeaderTable {
  const table = V2_HEADER_TABLES[modeId];
  if (alphabet.length !== table.base) {
    throw new Error(`v2 ${modeId} alphabet/table base mismatch`);
  }
  const declared = table.tier1LeadStates + table.tier2LeadStates
    + table.tier3LeadStates + table.unusedLeadStates + 1;
  if (declared !== table.base || table.tier1LeadStates !== (table.tier1.length + 1) * V2_STRUCTURAL_STATES) {
    throw new Error(`Invalid generated v2 header layout for ${modeId}`);
  }
  return table;
}

function checkedStructure(structure: number): number {
  if ((structure >> 2) === 3) throw new Error("Reserved v2 final-file state");
  return structure;
}

function digitIndex(digit: string | undefined, alphabet: string): number {
  if (digit === undefined) throw new Error("Truncated v2 header");
  const index = alphabet.indexOf(digit);
  if (index === -1) throw new Error(`Invalid v2 radix digit: ${digit}`);
  return index;
}

function requiredDigit(digits: string[], index: number): string {
  const digit = digits[index];
  if (digit === undefined) throw new Error("Truncated extended v2 header");
  return digit;
}

function escapeUnsafePathSurface(
  payload: string,
  table: GeneratedHeaderTable,
  alphabet: string,
  modeId: V2HeaderModeId,
): string {
  const pathSurface = payload.split("?", 1)[0];
  const hasDotSegment = pathSurface.split("/").some((segment) => segment === "." || segment === "..");
  const requiresQueryCarrier = RESERVED_ROUTE_PREFIXES.some((prefix) => payload.startsWith(prefix))
    || hasDotSegment;
  if (modeId !== "ascii" || !requiresQueryCarrier) {
    return payload;
  }
  return `${alphabet[table.base - 1]}${payload}`;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return [...left.payload].length - [...right.payload].length
    || left.headerCharacters - right.headerCharacters
    || left.order - right.order;
}
