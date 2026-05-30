import { ASCII_CLIENT_ALPHABET, ASCII_SERVER_ALPHABET, CJK_ALPHABET, hasClientFragment, isAsciiSafePayload, isCjkPayload } from "./alphabet";
import { decodeTokenStream, encodeTokenStream } from "./coder";
import { normalizeForCompression } from "./normalize";
import { decodeBits, encodeBits } from "./radix";
import { type TokenizeOptions, tokenize } from "./tokenize";

export const VERSION = "0";
export const DEFAULT_ORIGIN = "https://l.mia.cx";
const CLIENT_PAYLOAD_PREFIX = "#";

export type EncodeOptions = {
  allowFragment?: boolean;
  origin?: string;
  tokenizer?: TokenizeOptions;
  useCjkPayload?: boolean;
};

export type EncodeResult = {
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
  const bits = encodeTokenStream(tokenize(normalized.body, options.tokenizer), normalized.httpsOmitted);
  const allowFragment = Boolean(options.allowFragment);
  const origin = trimTrailingSlashes(options.origin ?? DEFAULT_ORIGIN);
  const serverAlphabet = options.useCjkPayload ? CJK_ALPHABET : ASCII_SERVER_ALPHABET;
  const clientAlphabet = options.useCjkPayload ? CJK_ALPHABET : ASCII_CLIENT_ALPHABET;
  const serverPayload = encodeBits(bits, serverAlphabet);
  const clientPayload = `${CLIENT_PAYLOAD_PREFIX}${encodeBits(bits, clientAlphabet)}`;
  const payload = allowFragment && clientPayload.length < serverPayload.length ? clientPayload : serverPayload;
  const shortUrl = `${origin}/${VERSION}/${payload}`;

  return {
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

export function decodeUrlPayload(payload: string): string {
  const surface = decodePayloadSurface(payload);
  const clientMax = surface.startsWith(CLIENT_PAYLOAD_PREFIX);
  const payloadBody = clientMax ? surface.slice(CLIENT_PAYLOAD_PREFIX.length) : surface;
  const alphabet = payloadAlphabet(surface, clientMax);
  const bits = decodeBits(payloadBody, alphabet);
  const decoded = decodeTokenStream(bits);

  return decoded.httpsOmitted ? `https://${decoded.body}` : decoded.body;
}

export function decodeShortUrl(shortUrlOrPayload: string): string {
  return decodeUrlPayload(extractPayloadSurface(shortUrlOrPayload));
}

export function extractPayloadSurface(shortUrlOrPayload: string): string {
  const marker = `/${VERSION}/`;
  const markerIndex = shortUrlOrPayload.indexOf(marker);

  if (markerIndex === -1) return shortUrlOrPayload;

  return shortUrlOrPayload.slice(markerIndex + marker.length);
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
