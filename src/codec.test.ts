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

  it("keeps # out of server-safe payloads", () => {
    const encoded = encodeUrl("https://example.com/a#frag", { allowFragment: false });

    expect(encoded.payload).not.toContain("#");
    expect(encoded.carrier).toBe("server-safe");
    expect(decodeUrlPayload(encoded.payload)).toBe("https://example.com/a#frag");
  });

  it("allows # in client-max payloads", () => {
    const encoded = encodeUrl("https://example.com/a#frag#two", { allowFragment: true });

    expect(encoded.payload).toContain("#");
    expect(encoded.carrier).toBe("client-max");
    expect(decodeUrlPayload(encoded.payload)).toBe("https://example.com/a#frag#two");
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

  it("rejects non-ASCII input in the MVP", () => {
    expect(() => encodeUrl("https://example.com/雪")).toThrow("non-ASCII");
  });
});
