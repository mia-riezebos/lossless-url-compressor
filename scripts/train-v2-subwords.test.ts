import { describe, expect, it } from "vitest";
import { trainUrlSubwords } from "./train-v2-subwords";

describe("v2 URL subword training", () => {
  it("learns recurring pieces from URL components rather than prose outside URLs", () => {
    const records = [
      "https://example.com/materialistic-forecast?comparison=materialistic",
      "https://example.com/materialistic-lighting?comparison=materialistic",
      "https://example.com/materialistic-letter?comparison=materialistic",
      "https://example.com/materialistic-forum?comparison=materialistic",
    ].map((url) => ({
      url,
      dataset: "test",
      linkClass: "message",
      linkPresentation: "visible-url",
      weight: 1,
    }));

    const trained = trainUrlSubwords(records, {
      vocabularySize: 8,
      minimumLength: 3,
      maximumLength: 16,
      minimumRawCount: 4,
      tokenBits: 12,
    });

    expect(trained.terms).toContain("materialistic");
    expect(trained.terms.some((term) => term.includes("https") || term.includes("example"))).toBe(false);
  });

  it("is deterministic and excludes existing exact terms", () => {
    const records = Array.from({ length: 4 }, (_, index) => ({
      url: `https://example.com/articles/${index}?search=articles`,
      dataset: "test",
      linkClass: "web",
      linkPresentation: "visible-url",
      weight: 1,
    }));
    const options = {
      vocabularySize: 10,
      minimumLength: 3,
      maximumLength: 12,
      minimumRawCount: 4,
      tokenBits: 12,
      reservedTerms: new Set(["articles"]),
    };

    expect(trainUrlSubwords(records, options).terms).toEqual(trainUrlSubwords(records, options).terms);
    expect(trainUrlSubwords(records, options).terms).not.toContain("articles");
  });
});
