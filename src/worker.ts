import { Hono } from "hono";
import { VERSION, decodeUrlPayload, extractPayloadSurface } from "./codec";

type Bindings = {
  ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("*", async (context) => {
  const rawUrl = context.req.raw.url;
  const marker = `/${VERSION}/`;
  const markerIndex = rawUrl.indexOf(marker);

  if (markerIndex !== -1) {
    const payload = extractPayloadSurface(rawUrl);
    if (payload) {
      try {
        return context.redirect(decodeUrlPayload(payload), 302);
      } catch (caught) {
        return context.text(caught instanceof Error ? caught.message : String(caught), 400);
      }
    }
  }

  return context.env.ASSETS.fetch(context.req.raw);
});

export default app;
