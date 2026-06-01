import { defineConfig, loadEnv } from "vite";
import { queryViews } from "./src/analytics";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    server: {
      host: "127.0.0.1",
    },
    plugins: [
      {
        name: "pisszip-local-api",
        configureServer(server) {
          server.middlewares.use("/api/views", async (_request, response) => {
            const views = await readLocalViews(env);

            response.statusCode = 200;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ views }));
          });
        },
      },
    ],
  };
});

async function readLocalViews(env: Record<string, string>): Promise<number | null> {
  try {
    const response = await fetch("https://piss.zip/api/views");
    if (response.ok) return (await response.json() as { views: number | null }).views;
  } catch {
    // Production may not be deployed or reachable; fall back to local analytics token.
  }

  const apiToken = process.env.PISSZIP_ANALYTICS_TOKEN ?? env.PISSZIP_ANALYTICS_TOKEN ?? process.env.CF_API_TOKEN ?? env.CF_API_TOKEN;
  return apiToken ? queryViews(apiToken) : null;
}
