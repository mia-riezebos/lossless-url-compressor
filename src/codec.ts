import { ASCII_CLIENT_ALPHABET, ASCII_SERVER_ALPHABET, CJK_ALPHABET, hasClientFragment, isAsciiSafePayload, isCjkPayload } from "./alphabet";
import { decodeTokenStream, encodeTokenStream } from "./coder";
import { decodeTokenStreamV1, decodeTokenStreamV2, decodeTokenStreamV3, encodeTokenStreamV1, encodeTokenStreamV2, encodeTokenStreamV3 } from "./coder-v1";
import { normalizeForCompression } from "./normalize";
import { decodeBits, decodeTerminatedBits, encodeBits, encodeTerminatedBits } from "./radix";
import { type TokenizeOptions, tokenize } from "./tokenize";

export const VERSION = "1";
export const DEFAULT_ORIGIN = "https://l.mia.cx";
const CLIENT_PAYLOAD_PREFIX = "#";

export type CodecVersion = "0" | "1" | "2" | "3";
export type EncodeVersion = CodecVersion | "auto";

export type EncodeOptions = {
  allowFragment?: boolean;
  origin?: string;
  tokenizer?: TokenizeOptions;
  useCjkPayload?: boolean;
  version?: EncodeVersion;
};

export type EncodeResult = {
  version: CodecVersion;
  normalizedUrl: string;
  payload: string;
  shortUrl: string;
  carrier: "server-safe" | "client-max";
  payloadFamily: "ascii-safe" | "unicode-cjk";
  stats: {
    normalizedLength: number;
    payloadLength: number;
    shortUrlLength: number;
  };
};

export function encodeUrl(input: string, options: EncodeOptions = {}): EncodeResult {
  const normalized = normalizeForCompression(input);
  const tokens = tokenize(normalized.body, options.tokenizer);
  const version = options.version ?? VERSION;
  const versions: CodecVersion[] = version === "auto" ? ["1", "2", "3"] : [version];
  const candidates = versions.map((candidate) => encodeUrlVersion(normalized, tokens, candidate, options));

  return candidates.reduce((best, candidate) => candidate.stats.shortUrlLength < best.stats.shortUrlLength ? candidate : best);
}

function encodeUrlVersion(
  normalized: ReturnType<typeof normalizeForCompression>,
  tokens: ReturnType<typeof tokenize>,
  version: CodecVersion,
  options: EncodeOptions,
): EncodeResult {
  const bits = encodeBitsForVersion(tokens, normalized.httpsOmitted, version);
  const allowFragment = Boolean(options.allowFragment);
  const origin = trimTrailingSlashes(options.origin ?? DEFAULT_ORIGIN);
  const serverAlphabet = options.useCjkPayload ? CJK_ALPHABET : ASCII_SERVER_ALPHABET;
  const clientAlphabet = options.useCjkPayload ? CJK_ALPHABET : ASCII_CLIENT_ALPHABET;
  const serverPayload = version === "0" ? encodeBits(bits, serverAlphabet) : encodeTerminatedBits(bits, serverAlphabet);
  const clientPayload = `${CLIENT_PAYLOAD_PREFIX}${version === "0" ? encodeBits(bits, clientAlphabet) : encodeTerminatedBits(bits, clientAlphabet)}`;
  const payload = allowFragment ? clientPayload : serverPayload;
  const shortUrl = `${origin}/${version}/${payload}`;

  return {
    version,
    normalizedUrl: normalized.normalizedUrl,
    payload,
    shortUrl,
    carrier: hasClientFragment(payload) ? "client-max" : "server-safe",
    payloadFamily: options.useCjkPayload ? "unicode-cjk" : "ascii-safe",
    stats: {
      normalizedLength: normalized.normalizedUrl.length,
      payloadLength: payload.length,
      shortUrlLength: shortUrl.length,
    },
  };
}

function encodeBitsForVersion(tokens: ReturnType<typeof tokenize>, httpsOmitted: boolean, version: CodecVersion): number[] {
  if (version === "0") return encodeTokenStream(tokens, httpsOmitted);
  if (version === "1") return encodeTokenStreamV1(tokens, httpsOmitted);
  if (version === "2") return encodeTokenStreamV2(tokens, httpsOmitted);
  return encodeTokenStreamV3(tokens, httpsOmitted);
}

export function decodeUrlPayload(payload: string, version: CodecVersion = VERSION): string {
  const surface = decodePayloadSurface(payload);
  const clientMax = surface.startsWith(CLIENT_PAYLOAD_PREFIX);
  const payloadBody = clientMax ? surface.slice(CLIENT_PAYLOAD_PREFIX.length) : surface;
  const alphabet = payloadAlphabet(surface, clientMax);
  if (!["0", "1", "2", "3"].includes(version)) throw new Error(`Unsupported payload version: ${version}`);

  const bits = version === "0" ? decodeBits(payloadBody, alphabet) : decodeTerminatedBits(payloadBody, alphabet);
  const decoded = decodeBitsForVersion(bits, version);

  return decoded.httpsOmitted ? `https://${decoded.body}` : decoded.body;
}

function decodeBitsForVersion(bits: number[], version: CodecVersion): { httpsOmitted: boolean; body: string } {
  if (version === "0") return decodeTokenStream(bits);
  if (version === "1") return decodeTokenStreamV1(bits);
  if (version === "2") return decodeTokenStreamV2(bits);
  return decodeTokenStreamV3(bits);
}

export function decodeShortUrl(shortUrlOrPayload: string): string {
  const parsed = parsePayloadSurface(shortUrlOrPayload);
  return decodeUrlPayload(parsed.payload, parsed.version);
}

export function extractPayloadSurface(shortUrlOrPayload: string): string {
  return parsePayloadSurface(shortUrlOrPayload).payload;
}

export function extractPayloadVersion(shortUrlOrPayload: string): CodecVersion {
  return parsePayloadSurface(shortUrlOrPayload).version;
}

function parsePayloadSurface(shortUrlOrPayload: string): { version: CodecVersion; payload: string } {
  const match = /\/([0-3])\//.exec(shortUrlOrPayload);
  if (!match) return { version: VERSION, payload: shortUrlOrPayload };

  return {
    version: match[1] as CodecVersion,
    payload: shortUrlOrPayload.slice(match.index + match[0].length),
  };
}

function decodePayloadSurface(payload: string): string {
  if (!payload.includes("%")) return payload;

  try {
    return decodeURIComponent(payload);
  } catch {
    throw new Error("Invalid percent-encoded payload surface");
  }
}

function payloadAlphabet(surface: string, clientMax: boolean): string {
  if (isAsciiSafePayload(surface)) return clientMax ? ASCII_CLIENT_ALPHABET : ASCII_SERVER_ALPHABET;
  if (isCjkPayload(surface)) return CJK_ALPHABET;
  throw new Error("Payload selects an unsupported Unicode codec");
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
