#!/usr/bin/env python3
"""Collect grouped piss.zip request paths from Cloudflare GraphQL analytics.

Uses the OAuth token from Wrangler's local config. Cloudflare currently limits this
zone's adaptive request path queries to <= 1 day, so the script walks day-sized
windows and aggregates path/status counts locally.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import tomllib
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

WRANGLER_CONFIG = Path.home() / "Library/Preferences/.wrangler/config/default.toml"
GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"
PISS_ZIP_ZONE_ID = "7ac41430e4caec320e535d1a16bf29bf"

QUERY = """
query($zone:String!,$start:Time!,$end:Time!,$limit:Int!) {
  viewer {
    zones(filter:{zoneTag:$zone}) {
      httpRequestsAdaptiveGroups(
        limit:$limit
        filter:{datetime_geq:$start, datetime_lt:$end}
        orderBy:[count_DESC]
      ) {
        count
        dimensions {
          clientRequestHTTPHost
          clientRequestPath
          edgeResponseStatus
        }
      }
    }
  }
}
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--limit", type=int, default=10000)
    parser.add_argument("--out", type=Path, default=Path("data/pisszip/visited-paths.json"))
    args = parser.parse_args()

    token = wrangler_oauth_token()
    end = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    start = end - dt.timedelta(days=args.days)

    paths: Counter[str] = Counter()
    statuses: dict[str, Counter[int]] = defaultdict(Counter)
    windows: list[dict[str, Any]] = []

    cursor = start
    while cursor < end:
        window_end = min(cursor + dt.timedelta(days=1), end)
        groups = query_window(token, cursor, window_end, args.limit)
        windows.append({
            "start": iso(cursor),
            "end": iso(window_end),
            "groups": len(groups),
            "truncated": len(groups) >= args.limit,
        })

        for group in groups:
            dimensions = group["dimensions"]
            if dimensions.get("clientRequestHTTPHost") != "piss.zip":
                continue
            path = dimensions["clientRequestPath"]
            status = int(dimensions["edgeResponseStatus"])
            count = int(group["count"])
            paths[path] += count
            statuses[path][status] += count

        print(f"{iso(cursor)}..{iso(window_end)} groups={len(groups)}")
        cursor = window_end

    output = {
        "source": "cloudflare:httpRequestsAdaptiveGroups",
        "zone": "piss.zip",
        "zone_id": PISS_ZIP_ZONE_ID,
        "collected_at": iso(dt.datetime.now(dt.timezone.utc)),
        "range": {"start": iso(start), "end": iso(end), "days": args.days},
        "windows": windows,
        "paths": [
            {
                "path": path,
                "count": count,
                "statuses": {str(status): status_count for status, status_count in sorted(statuses[path].items())},
            }
            for path, count in paths.most_common()
        ],
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {args.out} ({len(output['paths'])} paths, {sum(paths.values())} requests)")


def wrangler_oauth_token() -> str:
    with WRANGLER_CONFIG.open("rb") as file:
        config = tomllib.load(file)
    return config["oauth_token"]


def query_window(token: str, start: dt.datetime, end: dt.datetime, limit: int) -> list[dict[str, Any]]:
    body = json.dumps({
        "query": QUERY,
        "variables": {
            "zone": PISS_ZIP_ZONE_ID,
            "start": iso(start),
            "end": iso(end),
            "limit": limit,
        },
    }).encode()
    request = urllib.request.Request(
        GRAPHQL_URL,
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        data = json.load(response)

    if data.get("errors"):
        raise RuntimeError(json.dumps(data["errors"], indent=2))

    zones = data["data"]["viewer"]["zones"]
    if not zones:
        return []
    return zones[0]["httpRequestsAdaptiveGroups"]


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
