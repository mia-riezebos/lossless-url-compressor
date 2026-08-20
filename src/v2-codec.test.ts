import { describe, expect, it } from "vitest";
import {
  ASCII_SERVER_ALPHABET,
  CJK_ALPHABET,
} from "./alphabet";
import {
  decodeCanonicalShortUrl,
  decodeShortUrl,
  decodeUrlPayload,
  encodeUrl,
} from "./codec";
import {
  V2_CODEC_MODEL_HASH,
  V2_HEADER_TABLES,
  V2_HOST_ROUTE_TABLES,
  V2_PAYLOAD_DICTIONARY,
} from "./generated/v2-codec-model";

describe("trained v2 header codec", () => {
  const sources = [
    "http://example.net",
    "https://www.example.org/docs/index.html?q=1#frag",
    "http://www.example.com/admin/index.php",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://discord.com/channels/123/456",
    "https://user@example.dev:8443/a?b=c#d",
    "https://[2001:db8::1]:443/a",
    "https://example.com/雪",
  ];

  it.each([
    { allowFragment: false, useCjkPayload: false },
    { allowFragment: true, useCjkPayload: false },
    { allowFragment: false, useCjkPayload: true },
    { allowFragment: true, useCjkPayload: true },
  ])("roundtrips structural states and raw fallbacks in $allowFragment/$useCjkPayload mode", (options) => {
    for (const source of sources) {
      const encoded = encodeUrl(source, options);
      expect(encoded.header?.modelHash).toBe(V2_CODEC_MODEL_HASH);
      expect(decodeUrlPayload(encoded.payload)).toBe(source);
      expect(decodeCanonicalShortUrl(encoded.shortUrl)).toBe(source);
    }
  });

  it("roundtrips every non-reserved protocol/www/final-file structural state", () => {
    for (const scheme of ["http", "https"]) {
      for (const www of [false, true]) {
        for (const file of [null, "index.html", "index.php"] as const) {
          const source = `${scheme}://${www ? "www." : ""}example.com/docs/${file ?? "page"}?q=1#frag`;
          for (const options of [
            { allowFragment: false, useCjkPayload: false },
            { allowFragment: true, useCjkPayload: false },
            { allowFragment: false, useCjkPayload: true },
            { allowFragment: true, useCjkPayload: true },
          ]) {
            const encoded = encodeUrl(source, options);
            expect(decodeUrlPayload(encoded.payload)).toBe(source);
          }
        }
      }
    }
  });

  it("uses the frozen compact com/net/org selector order", () => {
    const com = encodeUrl("https://example.com/articles");
    const orgFile = encodeUrl("http://www.example.org/docs/index.php?q=1");

    expect(com.payload[0]).toBe("R");
    expect(com.header).toMatchObject({ characters: 1, selector: "suffix", value: "com" });
    expect(orgFile.payload[0]).toBe("6");
    expect(orgFile.header).toMatchObject({ characters: 1, selector: "suffix", value: "org" });
    expect(decodeUrlPayload(com.payload)).toBe("https://example.com/articles");
    expect(decodeUrlPayload(orgFile.payload)).toBe("http://www.example.org/docs/index.php?q=1");
  });

  it("uses two- and three-character ASCII headers and one-character CJK headers", () => {
    const youtubeAscii = encodeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ");
    const discordAscii = encodeUrl("https://discord.com/channels/1/2");
    const youtubeCjk = encodeUrl("https://youtube.com/watch?v=dQw4w9WgXcQ", { useCjkPayload: true });

    expect(youtubeAscii.header).toMatchObject({ characters: 2, selector: "host", value: "youtube.com" });
    expect(discordAscii.header).toMatchObject({ characters: 3, selector: "host", value: "discord.com" });
    expect(youtubeCjk.header).toMatchObject({ characters: 1, selector: "host", value: "youtube.com" });
  });

  it("uses the trained host-conditioned payload term after stripping the host", () => {
    const source = "https://youtube.com/watch?v=dQw4w9WgXcQ";
    const trained = encodeUrl(source, { useCjkPayload: true });
    const literals = encodeUrl(source, {
      useCjkPayload: true,
      tokenizer: { useDictionary: false, useShareDictionary: false, useRoutes: false },
    });

    expect(V2_PAYLOAD_DICTIONARY).toContain("/watch?v=");
    expect(V2_PAYLOAD_DICTIONARY).not.toContain(".com/");
    expect(V2_HOST_ROUTE_TABLES["youtube.com"]).toContainEqual({
      value: "/watch?v=",
      suffix: { alphabet: "base64url", length: 11 },
    });
    expect(trained.stats.payloadLength).toBeLessThan(literals.stats.payloadLength);
  });

  it("beats v1 on the representative YouTube URL after accounting for the complete short URL", () => {
    const source = "https://youtube.com/watch?v=dQw4w9WgXcQ";
    const v1 = encodeUrl(source, { version: "1", origin: "http://piss.zip" });
    const v2 = encodeUrl(source, { version: "2", origin: "http://piss.zip" });

    expect(decodeUrlPayload(v2.payload)).toBe(source);
    expect(v2.stats.shortUrlLength).toBeLessThan(v1.stats.shortUrlLength);
  });

  it("rejects reserved structural states, truncated headers, and unused packed tails", () => {
    const canonical = encodeUrl("https://example.com/a");
    const body = canonical.payload.slice(canonical.header?.characters);
    const reservedFile = `${ASCII_SERVER_ALPHABET[12]}${body}`;
    const truncatedTier2 = ASCII_SERVER_ALPHABET[V2_HEADER_TABLES.ascii.tier1LeadStates];
    const unusedPacked = 15 * 16;
    const unusedTier2 = `${
      ASCII_SERVER_ALPHABET[V2_HEADER_TABLES.ascii.tier1LeadStates + Math.floor(unusedPacked / 81)]
    }${ASCII_SERVER_ALPHABET[unusedPacked % 81]}${body}`;

    expect(() => decodeUrlPayload(reservedFile)).toThrow("Reserved v2 final-file state");
    expect(() => decodeUrlPayload(truncatedTier2)).toThrow("Truncated extended v2 header");
    expect(() => decodeUrlPayload(unusedTier2)).toThrow("Unused v2 tier-2 packed state");
  });

  it("decodes the generic route escape but rejects unnecessary aliases as non-canonical", () => {
    const source = "https://example.com/a";
    const canonical = encodeUrl(source);
    const alias = `${ASCII_SERVER_ALPHABET.at(-1)}${canonical.payload}`;

    expect(decodeUrlPayload(alias)).toBe(source);
    expect(decodeShortUrl(`http://piss.zip/${alias}`)).toBe(source);
    expect(() => decodeCanonicalShortUrl(`http://piss.zip/${alias}`)).toThrow("Non-canonical");
  });

  it("keeps generated table capacities internally consistent", () => {
    for (const table of Object.values(V2_HEADER_TABLES)) {
      expect(table.base).toBe(
        table.tier1LeadStates
          + table.tier2LeadStates
          + table.tier3LeadStates
          + table.unusedLeadStates
          + 1,
      );
      expect(table.tier1LeadStates).toBe((table.tier1.length + 1) * 16);
      expect(table.tier2.length).toBeLessThanOrEqual(Math.floor(table.tier2LeadStates * table.base / 16));
      expect(table.tier3.length).toBeLessThanOrEqual(
        Math.floor(table.tier3LeadStates * table.base * table.base / 16),
      );
    }
    expect(CJK_ALPHABET.length).toBe(V2_HEADER_TABLES.cjk.base);
  });
});
