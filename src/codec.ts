import { ASCII_CLIENT_ALPHABET, ASCII_SERVER_ALPHABET, hasClientFragment, isAsciiSafePayload } from "./alphabet";
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
};

export type EncodeResult = {
  normalizedUrl: string;
  payload: string;
  shortUrl: string;
  carrier: "server-safe" | "client-max";
  payloadFamily: "ascii-safe";
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
  const serverPayload = encodeBits(bits, ASCII_SERVER_ALPHABET);
  const clientPayload = `${CLIENT_PAYLOAD_PREFIX}${encodeBits(bits, ASCII_CLIENT_ALPHABET)}`;
  const payload = allowFragment && clientPayload.length < serverPayload.length ? clientPayload : serverPayload;
  const shortUrl = `${origin}/${VERSION}/${payload}`;

  return {
    normalizedUrl: normalized.normalizedUrl,
    payload,
    shortUrl,
    carrier: hasClientFragment(payload) ? "client-max" : "server-safe",
    payloadFamily: "ascii-safe",
    stats: {
      normalizedLength: normalized.normalizedUrl.length,
      payloadLength: payload.length,
      shortUrlLength: shortUrl.length,
    },
  };
}

export function decodeUrlPayload(payload: string): string {
  if (!isAsciiSafePayload(payload)) {
    throw new Error("Payload selects the future Unicode/CJK codec, which is not implemented in the MVP");
  }

  const clientMax = payload.startsWith(CLIENT_PAYLOAD_PREFIX);
  const payloadBody = clientMax ? payload.slice(CLIENT_PAYLOAD_PREFIX.length) : payload;
  const bits = decodeBits(payloadBody, clientMax ? ASCII_CLIENT_ALPHABET : ASCII_SERVER_ALPHABET);
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

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
