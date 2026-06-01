import { queryViews } from "./analytics";

const COUNTER_KEY = "views";
const ANALYTICS_SEEDED_AT_KEY = "analyticsSeededAt";
const D1_DUMP_INTERVAL_MS = 6 * 60 * 60 * 1000;

type ViewCounterEnv = {
  ANALYTICS_DB?: D1Database;
  PISSZIP_ANALYTICS_TOKEN?: string;
};

export class ViewCounter {
  constructor(private readonly state: DurableObjectState, private readonly env: ViewCounterEnv) {}

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (request.method === "POST" && pathname === "/increment") {
      return json({ views: await this.increment() });
    }

    if (request.method === "POST" && pathname === "/dump") {
      await this.dumpToD1();
      return json({ ok: true });
    }

    if (request.method === "GET" && pathname === "/read") {
      return json({ views: await this.read() });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.dumpToD1();
    await this.scheduleDump();
  }

  private async increment(): Promise<number> {
    return this.state.blockConcurrencyWhile(async () => {
      const current = await this.read();
      const views = current + 1;
      await this.state.storage.put(COUNTER_KEY, views);
      await this.scheduleDump();
      return views;
    });
  }

  private async read(): Promise<number> {
    const views = await this.state.storage.get<number>(COUNTER_KEY);
    return this.seedFromAnalyticsIfAvailable(typeof views === "number" ? views : 0);
  }

  private async seedFromAnalyticsIfAvailable(currentViews: number): Promise<number> {
    if (await this.state.storage.get<string>(ANALYTICS_SEEDED_AT_KEY)) return currentViews;
    if (!this.env.PISSZIP_ANALYTICS_TOKEN) return currentViews;

    try {
      const analyticsViews = await queryViews(this.env.PISSZIP_ANALYTICS_TOKEN);
      const views = Math.max(currentViews, analyticsViews);
      await this.state.storage.put(COUNTER_KEY, views);
      await this.state.storage.put(ANALYTICS_SEEDED_AT_KEY, new Date().toISOString());
      await this.scheduleDump();
      return views;
    } catch {
      return currentViews;
    }
  }

  private async scheduleDump(): Promise<void> {
    const currentAlarm = await this.state.storage.getAlarm();
    if (currentAlarm !== null) return;
    await this.state.storage.setAlarm(Date.now() + D1_DUMP_INTERVAL_MS);
  }

  private async dumpToD1(): Promise<void> {
    if (!this.env.ANALYTICS_DB) return;

    const views = await this.read();
    const now = new Date().toISOString();

    await this.env.ANALYTICS_DB.batch([
      this.env.ANALYTICS_DB.prepare(`
        INSERT INTO view_counters (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).bind(COUNTER_KEY, views, now),
      this.env.ANALYTICS_DB.prepare(`
        INSERT INTO view_counter_snapshots (key, value, created_at)
        VALUES (?1, ?2, ?3)
      `).bind(COUNTER_KEY, views, now),
    ]);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
