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
            const apiToken = process.env.CF_API_TOKEN ?? env.CF_API_TOKEN;
            const views = apiToken ? await queryViews(apiToken) : null;

            response.statusCode = 200;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ views }));
          });
        },
      },
    ],
  };
});
