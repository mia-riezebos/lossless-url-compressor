import { Hono } from "hono";
import { shouldCountVisitPath } from "./analytics";
import { decodeCanonicalShortUrl, decodeShortUrl, extractPayloadSurface } from "./codec";
export { ViewCounter } from "./view-counter";

type Bindings = {
  ASSETS: Fetcher;
  VIEW_COUNTER?: DurableObjectNamespace;
  PISSZIP_ANALYTICS_TOKEN?: string;
};

const COUNTER_URL = "https://view-counter.local";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/views", async (context) => {
  return context.json({ views: await readViews(context.env) });
});

app.get("*", async (context) => {
  const rawUrl = context.req.raw.url;
  if (shouldCountVisitPath(new URL(rawUrl).pathname)) {
    await incrementViews(context.env);
  }
  const payload = extractPayloadSurface(rawUrl);

  if (payload !== rawUrl) {
    if (!payload) return context.env.ASSETS.fetch(rootAssetRequest(context.req.raw));

    try {
      const destination = decodeCanonicalShortUrl(rawUrl);
      if (isEmbedBot(context.req.header("User-Agent") ?? "")) {
        return context.html(embedPage(destination), 200);
      }
      return context.redirect(destination, 302);
    } catch (caught) {
      try {
        decodeShortUrl(rawUrl);
        return context.env.ASSETS.fetch(rootAssetRequest(context.req.raw));
      } catch {
        return context.text(caught instanceof Error ? caught.message : String(caught), 400);
      }
    }
  }

  return context.env.ASSETS.fetch(context.req.raw);
});

async function readViews(env: Bindings): Promise<number | null> {
  const counter = viewCounter(env);
  if (!counter) return null;

  const response = await counter.fetch(`${COUNTER_URL}/read`);
  return (await response.json() as { views: number }).views;
}

async function incrementViews(env: Bindings): Promise<void> {
  await viewCounter(env)?.fetch(`${COUNTER_URL}/increment`, { method: "POST" });
}

function viewCounter(env: Bindings): DurableObjectStub | null {
  if (!env.VIEW_COUNTER) return null;
  return env.VIEW_COUNTER.get(env.VIEW_COUNTER.idFromName("global"));
}

function isEmbedBot(userAgent: string): boolean {
  return /bot|crawler|spider|facebookexternalhit|meta-externalagent|twitterbot|discordbot|slackbot|linkedinbot|telegrambot|whatsapp|embedly|quora link preview|skypeuripreview/i.test(userAgent);
}

function embedPage(destination: string): string {
  const escapedDestination = escapeHtml(destination);
  const description = `This URL was compressed using piss.zip, your destination: ${destination}`;
  const escapedDescription = escapeHtml(description);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>piss.zip compressed URL</title>
<meta name="description" content="${escapedDescription}" />
<meta property="og:title" content="piss.zip compressed URL" />
<meta property="og:description" content="${escapedDescription}" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="piss.zip compressed URL" />
<meta name="twitter:description" content="${escapedDescription}" />
</head>
<body>
<p>This URL was compressed using piss.zip, your destination: <a href="${escapedDestination}">${escapedDestination}</a></p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function rootAssetRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = "/";
  url.search = "";
  return new Request(url, request);
}

export default app;
