import { describe, expect, it } from "vitest";
import { decodeShortUrl, decodeUrlPayload, encodeUrl, extractPayloadSurface } from "./codec";
import { isAsciiSafePayload } from "./alphabet";

const ASCII_SAFE_WITH_OPTIONAL_HASH = /^[\x00-\x7f]*$/;

describe("MVP ASCII-safe codec", () => {
  it("roundtrips the motivating x.com URL", () => {
    const source = "https://x.com/yanorei32/status/2059594850694283362";
    const encoded = encodeUrl(source);

    expect(encoded.payload).not.toContain("%");
    expect(encoded.payload).not.toContain("#");
    expect(encoded.payload).toMatch(ASCII_SAFE_WITH_OPTIONAL_HASH);
    expect(encoded.normalizedUrl).toBe(source);
    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("roundtrips long URLs outside the trained dictionary", () => {
    const source = "https://github.com/mia-riezebos/berrycamp.github.io/tree/dev/wplace-templates/quantized/rooms";
    const encoded = encodeUrl(source);

    expect(encoded.payload).not.toContain("github");
    expect(encoded.payload).not.toContain("berrycamp");
    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("can emit and decode shorter visible CJK Unicode payloads", () => {
    const source = "https://github.com/mia-riezebos/berrycamp.github.io/tree/dev/wplace-templates/quantized/rooms";
    const ascii = encodeUrl(source, { origin: "https://piss.zip" });
    const cjk = encodeUrl(source, { origin: "https://piss.zip", useCjkPayload: true });

    expect(cjk.payloadFamily).toBe("unicode-cjk");
    expect(cjk.stats.payloadLength).toBeLessThan(ascii.stats.payloadLength);
    expect(cjk.stats.shortUrlLength).toBeLessThan(ascii.stats.shortUrlLength);
    expect(decodeUrlPayload(cjk.payload)).toBe(source);
  });

  it("decodes percent-encoded CJK payload surfaces", () => {
    const source = "https://example.com/blog/2026/05/28/how-to-build-things";
    const encoded = encodeUrl(source, { useCjkPayload: true });

    expect(decodeUrlPayload(encodeURIComponent(encoded.payload))).toBe(source);
  });

  it("compresses URLs that already contain CJK payload characters", () => {
    const source = "https://github.com/mia-riezebos/berrycamp.github.io/tree/dev/wplace-templates/quantized/rooms";
    const compressed = encodeUrl(source, { origin: "https://piss.zip", useCjkPayload: true }).shortUrl;
    const encodedAgain = encodeUrl(compressed, { useCjkPayload: true });

    expect(decodeUrlPayload(encodedAgain.payload)).toBe(compressed);
  });

  it("compresses corpus-shaped URLs below the normalized source length even with the short origin", () => {
    const source = "http://www.web.archive.org/web/20120101010101/http://www.google.com/search?q=wikipedia";
    const encoded = encodeUrl(source);

    expect(encoded.stats.shortUrlLength).toBeLessThan(encoded.stats.normalizedLength);
    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("normalizes scheme and host casing before omitting https", () => {
    const encoded = encodeUrl("HtTpS://Sub.Example.COM/Foo?A=B#Frag", { allowFragment: true });

    expect(decodeUrlPayload(encoded.payload)).toBe("https://sub.example.com/Foo?A=B#Frag");
  });

  it("preserves explicit non-https schemes", () => {
    const encoded = encodeUrl("HTTP://EXAMPLE.COM/Foo");

    expect(decodeUrlPayload(encoded.payload)).toBe("http://example.com/Foo");
  });

  it("does not confuse omitted https with an https URL whose body starts like a scheme", () => {
    const encoded = encodeUrl("https://http://x");

    expect(decodeUrlPayload(encoded.payload)).toBe("https://http://x");
  });

  it("escapes percent signs so ASCII-safe payload detection remains unambiguous", () => {
    const encoded = encodeUrl("https://example.com/a%20b?x=%23");

    expect(encoded.payload).not.toContain("%");
    expect(isAsciiSafePayload(encoded.payload)).toBe(true);
    expect(decodeUrlPayload(encoded.payload)).toBe("https://example.com/a%20b?x=%23");
  });

  it("roundtrips numeric runs with leading zeroes", () => {
    const source = "https://example.com/item/00001234567890123456";
    const encoded = encodeUrl(source);

    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("packs date slugs as numeric structure", () => {
    const source = "https://example.com/blog/2026/05/28/how-to-build-things";
    const encoded = encodeUrl(source);
    const withoutNumberTokens = encodeUrl(source, { tokenizer: { useNumbers: false } });

    expect(encoded.stats.payloadLength).toBeLessThan(withoutNumberTokens.stats.payloadLength);
    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("packs ISO datetime slugs as numeric structure", () => {
    const source = "https://example.com/events/2026-05-28T03:14:15.123Z/details";
    const encoded = encodeUrl(source);
    const withoutNumberTokens = encodeUrl(source, { tokenizer: { useNumbers: false } });

    expect(encoded.stats.payloadLength).toBeLessThan(withoutNumberTokens.stats.payloadLength);
    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("packs fixed-width u64-sized ids when they beat generic decimals", () => {
    const source = "https://example.com/status/18446744073709551615";
    const encoded = encodeUrl(source);

    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("packs UUIDs and long hex runs", () => {
    const uuidSource = "https://example.com/items/550e8400-e29b-41d4-a716-446655440000";
    const hexSource = "https://example.com/commit/0123456789abcdef0123456789abcdef01234567";

    expect(decodeUrlPayload(encodeUrl(uuidSource).payload)).toBe(uuidSource);
    expect(encodeUrl(uuidSource).stats.payloadLength).toBeLessThan(encodeUrl(uuidSource, { tokenizer: { useDictionary: false } }).stats.payloadLength);
    expect(decodeUrlPayload(encodeUrl(hexSource).payload)).toBe(hexSource);
  });

  it("packs percent-encoded byte runs", () => {
    const source = "https://example.com/redirect?to=https%3A%2F%2Fexample.org%2Ffoo%3Fx%3D1";
    const encoded = encodeUrl(source);

    expect(encoded.stats.payloadLength).toBeLessThan(encodeUrl(source, { tokenizer: { useDictionary: false } }).stats.payloadLength);
    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("packs URL-safe base64-ish ids and long lowercase hyphen slugs", () => {
    const source = "https://youtu.be/dQw4w9WgXcQ/how-to-build-a-stateless-lossless-url-compressor";
    const encoded = encodeUrl(source);

    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });

  it("keeps # out of server-safe payloads", () => {
    const encoded = encodeUrl("https://example.com/a#frag", { allowFragment: false });

    expect(encoded.payload).not.toContain("#");
    expect(encoded.carrier).toBe("server-safe");
    expect(decodeUrlPayload(encoded.payload)).toBe("https://example.com/a#frag");
  });

  it("allows but does not force fragment payloads", () => {
    const serverOnly = encodeUrl("https://example.com/a#frag#two", { allowFragment: false });
    const fragmentAllowed = encodeUrl("https://example.com/a#frag#two", { allowFragment: true });

    expect(fragmentAllowed.stats.payloadLength).toBeLessThanOrEqual(serverOnly.stats.payloadLength);
    expect(decodeUrlPayload(fragmentAllowed.payload)).toBe("https://example.com/a#frag#two");
  });

  it("decodes from a full short URL without URL parsing", () => {
    const encoded = encodeUrl("https://github.com/mia/lossless-url-compressor/issues/123");

    expect(decodeShortUrl(encoded.shortUrl)).toBe("https://github.com/mia/lossless-url-compressor/issues/123");
    expect(extractPayloadSurface(encoded.shortUrl)).toBe(encoded.payload);
  });

  it("uses deterministic output", () => {
    const source = "https://example.com/repeat/repeat/repeat?repeat=repeat";

    expect(encodeUrl(source).payload).toBe(encodeUrl(source).payload);
  });

  it("roundtrips non-ASCII input URLs", () => {
    const source = "https://example.com/雪";
    const encoded = encodeUrl(source, { useCjkPayload: true });

    expect(decodeUrlPayload(encoded.payload)).toBe(source);
  });
});
