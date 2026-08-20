import { describe, expect, it } from "vitest";
import worker from "./worker";
import { encodeUrl } from "./codec";

function assetMock(): { assets: Fetcher; requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    assets: {
      fetch: (request: Request) => {
        requests.push(request.url);
        return Promise.resolve(new Response("asset"));
      },
    } as unknown as Fetcher,
  };
}

describe("worker", () => {
  it("redirects server-safe short URLs to the decoded target", async () => {
    const source = "https://example.com/blog/2026/05/28/how-to-build-things";
    const encoded = encodeUrl(source, { origin: "https://l.mia.cx" });

    const { assets } = assetMock();
    const response = await worker.fetch(new Request(encoded.shortUrl), { ASSETS: assets });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(source);
  });

  it("serves embed metadata for crawler requests instead of redirecting", async () => {
    const source = "https://example.com/blog/2026/05/28/how-to-build-things";
    const encoded = encodeUrl(source, { origin: "https://l.mia.cx" });

    const { assets } = assetMock();
    const response = await worker.fetch(new Request(encoded.shortUrl, { headers: { "User-Agent": "Discordbot/2.0" } }), { ASSETS: assets });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(text).toContain("This URL was compressed using piss.zip, your destination:");
    expect(text).toContain(source);
  });

  it("returns null views when analytics token is not configured", async () => {
    const { assets } = assetMock();
    const response = await worker.fetch(new Request("https://l.mia.cx/api/views"), { ASSETS: assets });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ views: null });
  });

  it("serves the app shell for non-canonical short URLs", async () => {
    const source = "https://youtube.com/watch?v=dQw4w9WgXcQ";
    const alias = encodeUrl(source, {
      origin: "https://l.mia.cx",
      tokenizer: { useRoutes: false, useShareDictionary: false },
      useCjkPayload: true,
    });

    const { assets, requests } = assetMock();
    const response = await worker.fetch(new Request(alias.shortUrl), { ASSETS: assets });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
    expect(requests).toEqual(["http://l.mia.cx/"]);
  });

  it("redirects deployed legacy /1/ short URLs", async () => {
    const { assets, requests } = assetMock();
    const response = await worker.fetch(new Request("https://piss.zip/1/MdT$taB-qmBq;*"), { ASSETS: assets });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(requests).toEqual([]);
  });

  it("serves assets when no server-visible payload exists", async () => {
    const { assets } = assetMock();
    const response = await worker.fetch(new Request("https://l.mia.cx/"), { ASSETS: assets });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
  });

  it("cannot see fragment payloads and leaves them for client-side decode", async () => {
    const source = "https://example.com/blog/2026/05/28/how-to-build-things";
    const encoded = encodeUrl(source, { origin: "https://l.mia.cx", allowFragment: true });
    const serverVisibleUrl = encoded.shortUrl.slice(0, encoded.shortUrl.indexOf("#"));

    const { assets, requests } = assetMock();
    const response = await worker.fetch(new Request(serverVisibleUrl), { ASSETS: assets });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
    expect(requests).toEqual(["http://l.mia.cx/"]);
  });

  it("serves reserved application paths instead of treating them as v2 payloads", async () => {
    const { assets, requests } = assetMock();
    const response = await worker.fetch(new Request("https://piss.zip/assets/app.js"), { ASSETS: assets });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
    expect(requests).toEqual(["https://piss.zip/assets/app.js"]);
  });
});
