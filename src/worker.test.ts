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

  it("redirects v2 and v3 short URLs", async () => {
    const source = "https://developer.mozilla.org/en-US/docs/Web/API/URLSearchParams?utm_source=example&utm_medium=social&utm_campaign=test";

    for (const version of ["2", "3"] as const) {
      const { assets } = assetMock();
      const encoded = encodeUrl(source, { origin: "https://l.mia.cx", version, useCjkPayload: true });
      const response = await worker.fetch(new Request(encoded.shortUrl), { ASSETS: assets });

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(source);
    }
  });

  it("redirects legacy v0 short URLs", async () => {
    const { assets } = assetMock();
    const response = await worker.fetch(new Request("https://l.mia.cx/0/一亼篗帘鳀囻頸搧茁铃遹旰觇殮嘿"), { ASSETS: assets });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
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
    expect(requests).toEqual(["https://l.mia.cx/"]);
  });
});
