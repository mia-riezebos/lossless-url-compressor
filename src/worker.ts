import { Hono } from "hono";
import { decodeCanonicalShortUrl, extractPayloadSurface } from "./codec";

type Bindings = {
  ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("*", async (context) => {
  const rawUrl = context.req.raw.url;
  const payload = extractPayloadSurface(rawUrl);

  if (payload !== rawUrl) {
    if (!payload) return context.env.ASSETS.fetch(rootAssetRequest(context.req.raw));

    try {
      return context.redirect(decodeCanonicalShortUrl(rawUrl), 302);
    } catch (caught) {
      return context.text(caught instanceof Error ? caught.message : String(caught), 400);
    }
  }

  return context.env.ASSETS.fetch(context.req.raw);
});

function rootAssetRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = "/";
  url.search = "";
  return new Request(url, request);
}

export default app;
