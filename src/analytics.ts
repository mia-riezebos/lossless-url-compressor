const PISS_ZIP_ZONE_ID = "7ac41430e4caec320e535d1a16bf29bf";
const VIEW_COUNTER_DAYS = 7;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

export async function queryViews(apiToken: string, fetcher: typeof fetch = fetch): Promise<number> {
  const end = new Date();
  let views = 0;

  for (let day = VIEW_COUNTER_DAYS; day > 0; day -= 1) {
    const start = new Date(end);
    start.setUTCDate(end.getUTCDate() - day);
    const next = new Date(end);
    next.setUTCDate(end.getUTCDate() - day + 1);
    views += await queryViewsWindow(apiToken, start, next, fetcher);
  }

  return views;
}

async function queryViewsWindow(apiToken: string, start: Date, end: Date, fetcher: typeof fetch): Promise<number> {
  const response = await fetcher(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query($zone:String!,$start:Time!,$end:Time!){
        viewer {
          zones(filter:{zoneTag:$zone}) {
            httpRequestsAdaptiveGroups(
              limit: 10000
              filter:{datetime_geq:$start, datetime_lt:$end}
              orderBy:[count_DESC]
            ) {
              count
              dimensions { clientRequestHTTPHost clientRequestPath }
            }
          }
        }
      }`,
      variables: {
        zone: PISS_ZIP_ZONE_ID,
        start: start.toISOString(),
        end: end.toISOString(),
      },
    }),
  });

  const body = await response.json() as AnalyticsResponse;
  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.[0]?.message ?? `Cloudflare analytics failed: ${response.status}`);
  }

  return body.data.viewer.zones[0]?.httpRequestsAdaptiveGroups.reduce((total, group) => {
    return group.dimensions.clientRequestHTTPHost === "piss.zip" && shouldCountVisitPath(group.dimensions.clientRequestPath)
      ? total + group.count
      : total;
  }, 0) ?? 0;
}

type AnalyticsResponse = {
  errors?: Array<{ message: string }>;
  data: {
    viewer: {
      zones: Array<{
        httpRequestsAdaptiveGroups: Array<{
          count: number;
          dimensions: {
            clientRequestHTTPHost: string;
            clientRequestPath: string;
          };
        }>;
      }>;
    };
  };
};

export function shouldCountVisitPath(pathname: string): boolean {
  return ![
    "/api/",
    "/assets/",
    "/cdn-cgi/",
  ].some((prefix) => pathname.startsWith(prefix)) && !["/favicon.ico", "/sw.js"].includes(pathname);
}
