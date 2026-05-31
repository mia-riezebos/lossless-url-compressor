import { Hono } from "hono";
import { decodeShortUrl, extractPayloadSurface } from "./codec";

type Bindings = {
  ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("*", async (context) => {
  const rawUrl = context.req.raw.url;
  const payload = extractPayloadSurface(rawUrl);

  if (payload !== rawUrl) {
    if (payload) {
      try {
        return context.redirect(decodeShortUrl(rawUrl), 302);
      } catch (caught) {
        return context.text(caught instanceof Error ? caught.message : String(caught), 400);
      }
    }
  }

  return context.env.ASSETS.fetch(context.req.raw);
});

export default app;
