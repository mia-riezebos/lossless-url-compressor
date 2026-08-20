import { ASCII_CLIENT_ALPHABET, ASCII_SERVER_ALPHABET, CJK_ALPHABET, CJK_CLIENT_ALPHABET, hasClientFragment, isAsciiSafePayload, isCjkPayload } from "./alphabet";
import { decodeTokenStreamV1, encodeTokenStreamV1 } from "./coder-v1";
import type { V2HeaderModeId } from "./generated/v2-codec-model";
import { normalizeForCompression } from "./normalize";
import { decodeTerminatedBits, encodeTerminatedBits } from "./radix";
import { type TokenizeOptions, tokenize } from "./tokenize";
import { decodeV2Payload, encodeV2Payload, type V2HeaderSelection } from "./v2-codec";

export const VERSION = "2";
export const DEFAULT_ORIGIN = "http://piss.zip";
export const V2_WIRE_VERSION = 0;
const CLIENT_PAYLOAD_PREFIX = "#";

export type CodecVersion = "1" | "2";

export type EncodeOptions = {
  allowFragment?: boolean;
  origin?: string;
  tokenizer?: TokenizeOptions;
  useCjkPayload?: boolean;
  version?: CodecVersion;
};

export type EncodeResult = {
  version: CodecVersion;
  wireVersion: number | null;
  normalizedUrl: string;
  payload: string;
  shortUrl: string;
  carrier: "server-safe" | "client-max";
  payloadFamily: "ascii-safe" | "unicode-cjk";
  header: V2HeaderSelection | null;
  stats: {
    normalizedLength: number;
    payloadLength: number;
    shortUrlLength: number;
  };
};

export function encodeUrl(input: string, options: EncodeOptions = {}): EncodeResult {
  const normalized = normalizeForCompression(input);
  const version = options.version ?? VERSION;
  const allowFragment = Boolean(options.allowFragment);
  const origin = outputOrigin(options.origin ?? DEFAULT_ORIGIN, version);
  const useCjkPayload = Boolean(options.useCjkPayload);
  const alphabet = encodingAlphabet(useCjkPayload, allowFragment, version);
  const v2 = version === "2"
    ? encodeV2Payload(normalized, alphabet, v2Mode(useCjkPayload, allowFragment), options.tokenizer)
    : null;
  const encodedBody = v2?.payload ?? encodeV1Payload(
    normalized.body,
    normalized.httpsOmitted,
    alphabet,
    useCjkPayload,
    options.tokenizer,
  );
  const payload = allowFragment ? `${CLIENT_PAYLOAD_PREFIX}${encodedBody}` : encodedBody;
  const shortUrl = version === "1"
    ? `${origin}/1/${payload}`
    : allowFragment
      ? `${origin}${payload}`
      : `${origin}/${payload}`;

  return {
    version,
    wireVersion: version === "2" ? V2_WIRE_VERSION : null,
    normalizedUrl: normalized.normalizedUrl,
    payload,
    shortUrl,
    carrier: hasClientFragment(payload) ? "client-max" : "server-safe",
    payloadFamily: options.useCjkPayload ? "unicode-cjk" : "ascii-safe",
    header: v2?.header ?? null,
    stats: {
      normalizedLength: normalized.normalizedUrl.length,
      payloadLength: payload.length,
      shortUrlLength: shortUrl.length,
    },
  };
}

export function decodeUrlPayload(payload: string, version: CodecVersion = VERSION): string {
  const surface = decodePayloadSurface(payload);
  const clientMax = surface.startsWith(CLIENT_PAYLOAD_PREFIX);
  const payloadBody = clientMax ? surface.slice(CLIENT_PAYLOAD_PREFIX.length) : surface;
  const alphabet = payloadAlphabet(surface, clientMax, version);
  if (version === "2") {
    return decodeV2Payload(payloadBody, alphabet, v2Mode(isCjkPayload(surface), clientMax));
  }
  const decoded = decodeTokenStreamV1(decodeTerminatedBits(payloadBody, alphabet));

  return decoded.httpsOmitted ? `https://${decoded.body}` : decoded.body;
}

export function decodeShortUrl(shortUrlOrPayload: string): string {
  const parsed = parsePayloadSurface(shortUrlOrPayload);
  return decodeUrlPayload(parsed.payload, parsed.version);
}

export function decodeCanonicalShortUrl(shortUrlOrPayload: string): string {
  const parsed = parsePayloadSurface(shortUrlOrPayload);
  const decoded = decodeUrlPayload(parsed.payload, parsed.version);
  const surface = decodePayloadSurface(parsed.payload);
  const canonical = encodeUrl(decoded, {
    allowFragment: hasClientFragment(surface),
    useCjkPayload: isCjkPayload(surface),
    version: parsed.version,
  });

  if (surface !== canonical.payload) {
    throw new Error("Non-canonical short URL payload");
  }

  return decoded;
}

export function extractPayloadSurface(shortUrlOrPayload: string): string {
  return parsePayloadSurface(shortUrlOrPayload).payload;
}

export function extractPayloadVersion(shortUrlOrPayload: string): CodecVersion {
  return parsePayloadSurface(shortUrlOrPayload).version;
}

function parsePayloadSurface(shortUrlOrPayload: string): { version: CodecVersion; payload: string } {
  const legacy = /^[a-z][a-z\d+.-]*:\/\/[^/?#]+\/1\//i.exec(shortUrlOrPayload);
  if (legacy) {
    return {
      version: "1",
      payload: shortUrlOrPayload.slice(legacy[0].length),
    };
  }

  const fullUrl = /^([a-z][a-z\d+.-]*:\/\/[^/?#]+)([\/#])([\s\S]*)$/i.exec(shortUrlOrPayload);
  if (!fullUrl) return { version: VERSION, payload: shortUrlOrPayload };

  return {
    version: VERSION,
    payload: fullUrl[2] === "#" ? `#${fullUrl[3]}` : fullUrl[3],
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

function encodingAlphabet(useCjkPayload: boolean, clientMax: boolean, version: CodecVersion): string {
  if (!useCjkPayload) return clientMax ? ASCII_CLIENT_ALPHABET : ASCII_SERVER_ALPHABET;
  return version === "2" && clientMax ? CJK_CLIENT_ALPHABET : CJK_ALPHABET;
}

function payloadAlphabet(surface: string, clientMax: boolean, version: CodecVersion): string {
  if (isAsciiSafePayload(surface)) return clientMax ? ASCII_CLIENT_ALPHABET : ASCII_SERVER_ALPHABET;
  if (isCjkPayload(surface)) return version === "2" && clientMax ? CJK_CLIENT_ALPHABET : CJK_ALPHABET;
  throw new Error("Payload selects an unsupported Unicode codec");
}

function ensureDetectablePayloadFamily(payload: string, alphabet: string, useCjkPayload: boolean): string {
  if (useCjkPayload && ![...payload].some((char) => char.charCodeAt(0) > 0x7f)) {
    // A CJK+fragment integer can theoretically encode entirely as `#` digits,
    // which would otherwise be indistinguishable from the ASCII family.
    return `${alphabet[0]}${payload}`;
  }
  return payload;
}

function encodeV1Payload(
  body: string,
  httpsOmitted: boolean,
  alphabet: string,
  useCjkPayload: boolean,
  tokenizerOptions: TokenizeOptions | undefined,
): string {
  const tokens = tokenize(body, tokenizerOptions, { version: "v1" });
  const encoded = encodeTerminatedBits(encodeTokenStreamV1(tokens, httpsOmitted), alphabet);
  return ensureDetectablePayloadFamily(encoded, alphabet, useCjkPayload);
}

function v2Mode(useCjkPayload: boolean, clientMax: boolean): V2HeaderModeId {
  if (useCjkPayload) return clientMax ? "cjk-fragment" : "cjk";
  return clientMax ? "ascii-fragment" : "ascii";
}

function outputOrigin(value: string, version: CodecVersion): string {
  const origin = value.replace(/\/+$/, "");
  return version === "2" ? origin.replace(/^https:/i, "http:") : origin;
}
