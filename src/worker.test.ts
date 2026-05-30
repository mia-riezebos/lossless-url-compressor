import { describe, expect, it } from "vitest";
import worker from "./worker";
import { encodeUrl } from "./codec";

const ASSETS = {
  fetch: () => Promise.resolve(new Response("asset")),
} as unknown as Fetcher;

describe("worker", () => {
  it("redirects server-safe short URLs to the decoded target", async () => {
    const source = "https://example.com/blog/2026/05/28/how-to-build-things";
    const encoded = encodeUrl(source, { origin: "https://l.mia.cx" });

    const response = await worker.fetch(new Request(encoded.shortUrl), { ASSETS });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(source);
  });

  it("serves assets when no server-visible payload exists", async () => {
    const response = await worker.fetch(new Request("https://l.mia.cx/"), { ASSETS });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
  });
});
