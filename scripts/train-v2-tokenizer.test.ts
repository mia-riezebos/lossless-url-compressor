import { describe, expect, it } from "vitest";
import { inferStructuredSuffix, selectUniversalTerms, validRouteTerm } from "./train-v2-tokenizer";

describe("v2 tokenizer training", () => {
  it("rejects route fragments produced by markdown leakage", () => {
    for (const value of ["/*https:/", "/](https:/", "/)[/", "/[Post](https:/"]) {
      expect(validRouteTerm(value)).toBe(false);
    }
    for (const value of ["/watch?v=", "/wiki/", "?utm_source=", "/100%25-real/"]) {
      expect(validRouteTerm(value)).toBe(true);
    }
  });

  it("infers a fixed YouTube video-id suffix from held-out tails", () => {
    const tails = Array.from({ length: 10 }, (_, index) => `/watch?v=dQw4w9WgXc${index}`);
    expect(inferStructuredSuffix(tails, "/watch?v=")).toMatchObject({
      alphabet: "base64url",
      length: 11,
      confidence: 1,
      observations: 10,
    });
  });

  it("does not spend two universal slots on a lower-value substring", () => {
    const selected = selectUniversalTerms([
      { key: "/news/", weightedCount: 100, estimatedBitsSaved: 1_000 },
      { key: "/news", weightedCount: 90, estimatedBitsSaved: 900 },
      { key: "/status/", weightedCount: 80, estimatedBitsSaved: 800 },
    ], 2);
    expect(selected).toEqual(["/news/", "/status/"]);
  });
});
